import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changelogContext,
  defaultBase,
  docsRefreshContext,
  prReadyContext,
  rangeArgOrDefault,
  releaseNotesContext,
  resolvePrBranchContext,
  currentBranch,
  isProtectedBranch,
  isPrBranch,
} from "../../packages/workit-core/src/core/repo-context";
import { runVerifyProject } from "../../packages/workit-core/src/core/verify-project";
import { parseVerifyOutput } from "../../packages/workit-core/src/core/verify-parse";
import {
  parseKeyValueLines,
  parseSections,
} from "../../packages/workit-core/src/core/parse-sections";
import { gitContext } from "../../packages/workit-core/src/core/git";
import { syncRuntime } from "../../packages/workit-core/src/core/sync-runtime";
import { youTrackApi } from "../../packages/workit-core/src/core/youtrack";

// Parity between the TS runtime ports and the maintained shell behavior they
// replaced. Fixtures below were captured from the real scripts before the shell
// port: runVerifyProject / context generators must reproduce the same parsed
// sections, counts, and error text.

const scriptsRoot = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core", "scripts");

function buildFixtureRepo(): { repo: string; mergeBase: string } {
  const repo = mkdtempSync(path.join(os.tmpdir(), "wf-parity-repo-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Workflow Test"]);
  git(["config", "user.email", "workflow@example.test"]);
  mkdirSync(path.join(repo, ".github"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Fixture\n\nbase\n");
  writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- base\n",
  );
  writeFileSync(
    path.join(repo, ".github/pull_request_template.md"),
    "## Summary\n- fix\n\n## Validation\n- [ ] Not run\n",
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["branch", "develop"]);
  writeFileSync(path.join(repo, "README.md"), "# Fixture\n\nbase\nmainline\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "main base"]);
  git(["checkout", "-q", "-b", "feature/fixture"]);
  writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feature change"]);
  const mergeBase = git(["merge-base", "develop", "HEAD"]).stdout.trim();
  return { repo, mergeBase };
}

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "WORKFLOW_TOOLKIT_CONFIG",
  "WORKFLOW_TOOLKIT_CONFIG_DIR",
  "WORKFLOW_VCS_CONFIG",
  "WORKFLOW_WORKSPACE_ROOT",
  "PATH",
];

const withEnv = <T>(overrides: Record<string, string | undefined>, fn: () => T): T => {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const withGitLabConfig = <T>(fn: (configFiles: Record<string, string>) => T): T => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-parity-xdg-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  const files = {
    "vcs.json": JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
    "workspaces.json": JSON.stringify({
      workspaces: [
        { name: "work", glob: "**", vcs: { provider: "gitlab", defaultTargetBranch: "develop" } },
      ],
    }),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(legacy, name), content, "utf8");
  }
  return withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    try {
      return fn(files);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
};

function bashAvailable(): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
}

function flockAvailable(): boolean {
  return spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;
}

test("defaultBase prefers main then develop; rangeArgOrDefault appends ...HEAD", () => {
  const { repo } = buildFixtureRepo();
  try {
    expect(defaultBase(repo)).toBe("main");
    expect(rangeArgOrDefault(undefined, repo)).toBe("main...HEAD");
    expect(rangeArgOrDefault("v1.0.0..v2.0.0", repo)).toBe("v1.0.0..v2.0.0");
    // a repo with no main/master falls back through the ref list to HEAD~1
    const bare = mkdtempSync(path.join(os.tmpdir(), "wf-parity-bare-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: bare });
      expect(defaultBase(bare)).toBe("HEAD~1");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch classification and current branch match the shell predicates", () => {
  const { repo } = buildFixtureRepo();
  try {
    expect(currentBranch(repo)).toBe("feature/fixture");
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("master")).toBe(true);
    expect(isProtectedBranch("develop")).toBe(true);
    expect(isProtectedBranch("prod")).toBe(true);
    expect(isProtectedBranch("production")).toBe(true);
    expect(isProtectedBranch("feature/x")).toBe(false);
    expect(isPrBranch("feature/x")).toBe(true);
    expect(isPrBranch("bugfix/x")).toBe(true);
    expect(isPrBranch("main")).toBe(false);
    expect(isPrBranch("chore/x")).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolvePrBranchContext yields the branch-exclusive range the shell produced", () => {
  const { repo, mergeBase } = buildFixtureRepo();
  try {
    const ctx = withGitLabConfig(() => resolvePrBranchContext(repo));
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    expect(ctx.value.baseRef).toBe("develop");
    expect(ctx.value.range).toBe("develop..HEAD");
    expect(ctx.value.diffRange).toBe(`${mergeBase}..HEAD`);
    expect(ctx.value.mergeBase).toBe(mergeBase);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pr-ready-context sections match the shell output (auto branch-exclusive range)", () => {
  const { repo } = buildFixtureRepo();
  try {
    const result = withGitLabConfig(() => prReadyContext(repo));
    expect(result.exitCode).toBe(0);
    const sections = parseSections(result.stdout);
    const repoSection = parseKeyValueLines(sections.Repository ?? "", [
      "root",
      "branch",
      "range",
      "base_ref",
      "merge_base",
      "diff_range",
      "range_mode",
    ]);
    expect(repoSection.branch).toBe("feature/fixture");
    expect(repoSection.range).toBe("develop..HEAD");
    expect(repoSection.base_ref).toBe("develop");
    expect(repoSection.range_mode).toBe("branch-exclusive");
    expect(repoSection.diff_range).toBe(`${repoSection.merge_base}..HEAD`);
    expect(sections.Commits ?? "").toContain("feature change");
    expect(sections.Commits ?? "").toContain("main base"); // develop..HEAD includes both
    expect(sections["Diff Stat"] ?? "").toContain("feature.txt");
    expect(sections["Changed Files"] ?? "").toContain("feature.txt");
    expect(sections["Changed Files"] ?? "").toContain("README.md");
    expect(sections["PR Template"] ?? "").toContain(
      "template_path: .github/pull_request_template.md",
    );
    // parseSections splits on "## ", so the template body lands in its own section
    expect(sections.Summary ?? "").toContain("- fix");
    expect(sections["VCS Config"] ?? "").toContain("workspace: work");
    expect(sections["VCS Config"] ?? "").toContain("provider: gitlab");
    expect(sections["Merged PR Style"] ?? "").toContain("vcs not configured"); // no token -> no network
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pr-ready-context with an explicit range skips the branch-exclusive fields", () => {
  const { repo } = buildFixtureRepo();
  try {
    const result = withGitLabConfig(() => prReadyContext(repo, "HEAD~2..HEAD"));
    expect(result.exitCode).toBe(0);
    const repoSection = parseKeyValueLines(parseSections(result.stdout).Repository ?? "", [
      "branch",
      "range",
      "base_ref",
      "range_mode",
    ]);
    expect(repoSection.range).toBe("HEAD~2..HEAD");
    expect(repoSection.base_ref).toBeUndefined();
    expect(repoSection.range_mode).toBeUndefined();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pr-ready-context errors on protected branches with the shell message", () => {
  const { repo } = buildFixtureRepo();
  try {
    spawnSync("git", ["checkout", "-q", "main"], { cwd: repo });
    const result = withGitLabConfig(() => prReadyContext(repo));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot build PR context on protected branch main");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("changelog-context sections match the shell output", () => {
  const { repo } = buildFixtureRepo();
  try {
    const result = changelogContext(repo);
    expect(result.exitCode).toBe(0);
    const sections = parseSections(result.stdout);
    const repoSection = parseKeyValueLines(sections.Repository ?? "", ["branch", "range"]);
    expect(repoSection.branch).toBe("feature/fixture");
    expect(repoSection.range).toBe("main...HEAD");
    expect(sections["Keep a Changelog Rules"] ?? "").toContain("Use an [Unreleased] section.");
    // parseSections splits on "## ", so the excerpt ends at the changelog's own
    // "## [Unreleased]" heading — identical to how the shell output was parsed.
    expect(sections["Existing CHANGELOG.md"] ?? "").toBe("# Changelog");
    expect(sections.Commits ?? "").toContain("feature change");
    expect(sections["Changed Files"] ?? "").toBe("feature.txt");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("docs-refresh-context sections match the shell output", () => {
  const { repo } = buildFixtureRepo();
  try {
    const result = docsRefreshContext(repo);
    expect(result.exitCode).toBe(0);
    const sections = parseSections(result.stdout);
    expect(parseKeyValueLines(sections.Repository ?? "", ["range"]).range).toBe("main...HEAD");
    expect(sections["Changed Files"] ?? "").toBe("feature.txt");
    const docFiles = sections["Documentation Files"] ?? "";
    expect(docFiles).toContain("./CHANGELOG.md");
    expect(docFiles).toContain("./README.md");
    expect(docFiles).toContain("./.github/pull_request_template.md");
    expect(sections["README Preview"] ?? "").toContain("# Fixture");
    expect(sections["Package Scripts"] ?? "").toBe("package.json not found.");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("release-notes-context requires a range and reproduces the shell sections", () => {
  const { repo } = buildFixtureRepo();
  try {
    const missing = releaseNotesContext(repo, "");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("ERROR: release tag or range required");

    const explicit = releaseNotesContext(repo, "HEAD");
    expect(explicit.exitCode).toBe(0);
    const sections = parseSections(explicit.stdout);
    const repoSection = parseKeyValueLines(sections.Repository ?? "", ["requested", "range"]);
    expect(repoSection.requested).toBe("HEAD");
    expect(repoSection.range).toBe("HEAD");
    expect(sections.Commits ?? "").toContain("feature change");
    expect(sections["Existing Release Files"] ?? "").toBe("CHANGELOG.md");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verify-project reproduces the shell's parsed counts and check labels", () => {
  const { repo } = buildFixtureRepo();
  try {
    const result = runVerifyProject(repo);
    const parsed = parseVerifyOutput(result.stdout);
    expect(parsed).toEqual({
      passed: 1,
      failed: 0,
      skipped: 2,
      // skipped checks have no `command:` line, so they don't appear as commands
      commands: [
        {
          label: "CHANGELOG.md format",
          command: 'grep -qi "## [Unreleased]" CHANGELOG.md',
          status: "pass",
        },
      ],
    });
    expect(result.exitCode).toBe(0);

    // failing changelog -> exit 1 (shell parity)
    rmSync(path.join(repo, "CHANGELOG.md"));
    const failing = runVerifyProject(repo);
    expect(failing.exitCode).toBe(1);
    expect(parseVerifyOutput(failing.stdout).failed).toBe(1);

    // dry-run skips every check
    const dry = runVerifyProject(repo, true);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry_run: true");
    const dryParsed = parseVerifyOutput(dry.stdout);
    expect(dryParsed.failed).toBe(0);
    expect(dryParsed.skipped).toBe(3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verify-project picks the package runner and runs package.json scripts", () => {
  const { repo } = buildFixtureRepo();
  try {
    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture","scripts":{"lint":"true"}}');
    const result = runVerifyProject(repo);
    const parsed = parseVerifyOutput(result.stdout);
    expect(parsed.passed).toBe(2); // lint + changelog
    const lint = parsed.commands.find((c: any) => c.label === "lint");
    expect(lint).toEqual({ label: "lint", command: "npm run lint", status: "pass" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verify-project from a git subdirectory checks the repo root (shell cd parity)", () => {
  const { repo } = buildFixtureRepo();
  try {
    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture","scripts":{"lint":"true"}}');
    const subdir = path.join(repo, "src");
    mkdirSync(subdir, { recursive: true });
    // The shell did `root=$(git rev-parse --show-toplevel || pwd); cd "$root"`, so
    // verify run from a subdir must inspect the repo root's manifests.
    const result = runVerifyProject(subdir);
    expect(result.cwd).toBe(path.resolve(repo));
    const parsed = parseVerifyOutput(result.stdout);
    expect(parsed.passed).toBe(2); // lint + changelog, both from the repo root
    const lint = parsed.commands.find((c: any) => c.label === "lint");
    expect(lint).toEqual({ label: "lint", command: "npm run lint", status: "pass" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("maintained verify path runs against a fixture repo whose path contains a space", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "wf parity "));
  const repo = path.join(parent, "repo with space");
  try {
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture","scripts":{"lint":"true"}}');
    writeFileSync(
      path.join(repo, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- base\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const subdir = path.join(repo, "src");
    mkdirSync(subdir, { recursive: true });
    // A space in the toplevel path must survive repo_root normalization and the
    // subdir must still resolve to the root, exactly like the quoted shell.
    const result = runVerifyProject(subdir);
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(path.resolve(repo));
    const parsed = parseVerifyOutput(result.stdout);
    expect(parsed.passed).toBe(2);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("git context exposes the same branch and status fields the shell produced", () => {
  const { repo } = buildFixtureRepo();
  try {
    writeFileSync(path.join(repo, "untracked.txt"), "keep\n");
    const ctx = gitContext(repo);
    expect(ctx.branch).toBe("feature/fixture");
    expect(ctx.untracked).toContain("untracked.txt");
    expect(ctx.workspace_root).toBe(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PATH scanning uses path.delimiter (Windows-safe) not a literal colon", () => {
  const prCreateSource = readFileSync(
    path.resolve(import.meta.dir, "..", "..", "packages", "workit-core", "src/core/pr-create.ts"),
    "utf8",
  );
  expect(prCreateSource).toContain("split(path.delimiter)");
  // Functional delimiter coverage lives in workspaces-scripts.test.ts: the
  // missing-CLI guard runs whichOnPath over a path.delimiter-joined PATH.
});

test("YouTrack API uses fetch (not the curl binary) and never leaks the token", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-fetch-"));
  const tokenPath = path.join(dir, "youtrack.token");
  const configPath = path.join(dir, "youtrack.json");
  writeFileSync(tokenPath, "secret-token\n", { mode: 0o600 });
  writeFileSync(
    configPath,
    JSON.stringify({ tokenFile: tokenPath, baseUrl: "https://youtrack.example.test" }),
  );
  const previous = process.env.WORKFLOW_YOUTRACK_CONFIG;
  const originalFetch = globalThis.fetch;
  let seenAuth = "";
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    seenAuth = String((init as { headers?: Record<string, string> })?.headers?.Authorization ?? "");
    return new Response("boom", { status: 500 });
  }) as unknown as typeof fetch;
  process.env.WORKFLOW_YOUTRACK_CONFIG = configPath;
  try {
    const result = await youTrackApi(["post-comment", "NSR-40", "Revisado"], "1");
    expect(seenAuth).toBe("Bearer secret-token"); // header carried, exactly like curl -H
    expect("error" in result).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
    else process.env.WORKFLOW_YOUTRACK_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no runtime source spawns curl anymore", () => {
  const coreSrc = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core", "src");
  const youtrack = readFileSync(path.join(coreSrc, "core/youtrack.ts"), "utf8");
  expect(youtrack).not.toMatch(/spawnSync\(\s*"curl"/);
  const vcs = readFileSync(path.join(coreSrc, "core/vcs-config.ts"), "utf8");
  expect(vcs).not.toMatch(/spawnSync\(\s*"curl"/);
});

test.skipIf(!bashAvailable() || !flockAvailable())(
  "syncRuntime matches sync-runtime.sh RR-05 failure behavior",
  async () => {
    const runScript = (env: Record<string, string>) =>
      spawnSync("bash", [path.join(scriptsRoot, "sync-runtime.sh")], { env, encoding: "utf8" });

    // missing flock -> FATAL with the exact message
    const binDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-bin-"));
    for (const tool of ["bash", "dirname"]) {
      const real = findOnPath(tool);
      if (real) symlinkSync(real, path.join(binDir, tool));
    }
    const mkEnv = (extra: Record<string, string> = {}) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined || k.startsWith("WORKFLOW_") || k === "XDG_RUNTIME_DIR") continue;
        env[k] = v;
      }
      return { ...env, ...extra };
    };
    try {
      const home = mkdtempSync(path.join(os.tmpdir(), "wf-parity-home-"));
      try {
        const env = mkEnv({ HOME: home, PATH: binDir });
        const ts = await syncRuntime({ env });
        const bash = runScript(env);
        expect(ts.ok).toBe(false);
        expect("error" in ts && ts.error).toContain("flock");
        expect(bash.status).not.toBe(0);
        expect(bash.stderr).toContain("flock");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }

      // held lock -> fails loudly in both
      const heldHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-held-"));
      const heldLockDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lock-"));
      const holder = spawn(
        "bash",
        [
          "-c",
          `exec 9>"$1"; flock -n 9 || exit 1; : >"$2"; sleep 30`,
          "holder",
          path.join(heldLockDir, "workflow-toolkit-sync.lock"),
          path.join(heldLockDir, "held"),
        ],
        { stdio: "ignore" },
      );
      try {
        for (let i = 0; i < 200 && !existsSync(path.join(heldLockDir, "held")); i++) {
          await Bun.sleep(25);
        }
        const env = mkEnv({ HOME: heldHome, XDG_RUNTIME_DIR: heldLockDir });
        const ts = await syncRuntime({ env });
        const bash = runScript(env);
        expect(ts.ok).toBe(false);
        expect("error" in ts && ts.error).toContain("lock");
        expect(bash.status).not.toBe(0);
        expect(bash.stderr).toContain("lock");
      } finally {
        holder.kill();
        rmSync(heldHome, { recursive: true, force: true });
        rmSync(heldLockDir, { recursive: true, force: true });
      }

      // failed dependency install in dev mode -> nonzero in both
      const devHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devhome-"));
      const devLockDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devlock-"));
      const npmBin = mkdtempSync(path.join(os.tmpdir(), "wf-parity-npm-"));
      const dev = mkdtempSync(path.join(os.tmpdir(), "wf-parity-dev-"));
      spawnSync("git", ["init", "-q"], { cwd: dev });
      mkdirSync(path.join(dev, "packages/workit-opencode/src"), { recursive: true });
      mkdirSync(path.join(dev, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
      mkdirSync(path.join(dev, "packages/workit-cursor/mcp"), { recursive: true });
      writeFileSync(
        path.join(dev, "packages/workit-opencode/src/plugin.ts"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(npmBin, "npm"),
        "#!/usr/bin/env bash\necho 'npm unavailable' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const devHome2 = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devhome2-"));
      const devLockDir2 = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devlock2-"));
      try {
        const env = mkEnv({
          HOME: devHome,
          XDG_RUNTIME_DIR: devLockDir,
          WORKFLOW_TOOLKIT_DEV: dev,
          PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
        });
        const ts = await syncRuntime({ env });
        expect(ts.ok).toBe(false);
        expect("error" in ts && ts.error).toContain("npm");

        const bashEnv = mkEnv({
          HOME: devHome2,
          XDG_RUNTIME_DIR: devLockDir2,
          WORKFLOW_TOOLKIT_DEV: dev,
          PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
        });
        const bash = runScript(bashEnv);
        expect(bash.status).not.toBe(0);
        expect(bash.stderr).toContain("npm");
      } finally {
        rmSync(devHome, { recursive: true, force: true });
        rmSync(devLockDir, { recursive: true, force: true });
        rmSync(devHome2, { recursive: true, force: true });
        rmSync(devLockDir2, { recursive: true, force: true });
        rmSync(npmBin, { recursive: true, force: true });
        rmSync(dev, { recursive: true, force: true });
      }

      // failed skills rsync in dev mode -> not success in either (the shell
      // aborted under set -euo pipefail; the port must not swallow it).
      const skillsHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-vend-home-"));
      const skillsLockDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-vend-lock-"));
      const skillsBashHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-vend-home2-"));
      const skillsBashLock = mkdtempSync(path.join(os.tmpdir(), "wf-parity-vend-lock2-"));
      const fakeRsyncDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-fakersync-"));
      const skillsDev = mkdtempSync(path.join(os.tmpdir(), "wf-parity-vend-dev-"));
      const realRsync = findOnPath("rsync");
      spawnSync("git", ["init", "-q"], { cwd: skillsDev });
      mkdirSync(path.join(skillsDev, "packages/workit-opencode/src"), { recursive: true });
      mkdirSync(path.join(skillsDev, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
      mkdirSync(path.join(skillsDev, "packages/workit-cursor/mcp"), { recursive: true });
      mkdirSync(path.join(skillsDev, "packages/workit-core/vendor/superpowers/skills"), {
        recursive: true,
      });
      writeFileSync(
        path.join(skillsDev, "packages/workit-opencode/src/plugin.ts"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(skillsDev, "packages/workit-core/vendor/superpowers/skills/README.md"),
        "skills\n",
      );
      writeFileSync(
        path.join(fakeRsyncDir, "rsync"),
        [
          "#!/usr/bin/env bash",
          'if [[ "$*" == *vendor/superpowers* ]]; then',
          '  echo "FATAL: skills rsync failed" >&2',
          "  exit 1",
          "fi",
          'exec "$REAL_RSYNC" "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const tsSkills = await syncRuntime({
          env: mkEnv({
            HOME: skillsHome,
            XDG_RUNTIME_DIR: skillsLockDir,
            WORKFLOW_TOOLKIT_DEV: skillsDev,
            PATH: `${fakeRsyncDir}${path.delimiter}${process.env.PATH ?? ""}`,
            REAL_RSYNC: realRsync ?? "rsync",
          }),
        });
        expect(tsSkills.ok).toBe(false);
        expect("error" in tsSkills && tsSkills.error).toContain("skills rsync failed");

        const bashSkills = runScript(
          mkEnv({
            HOME: skillsBashHome,
            XDG_RUNTIME_DIR: skillsBashLock,
            WORKFLOW_TOOLKIT_DEV: skillsDev,
            PATH: `${fakeRsyncDir}${path.delimiter}${process.env.PATH ?? ""}`,
            REAL_RSYNC: realRsync ?? "rsync",
          }),
        );
        expect(bashSkills.status).not.toBe(0);
        expect(bashSkills.stderr).toContain("skills rsync failed");
      } finally {
        rmSync(skillsHome, { recursive: true, force: true });
        rmSync(skillsLockDir, { recursive: true, force: true });
        rmSync(skillsBashHome, { recursive: true, force: true });
        rmSync(skillsBashLock, { recursive: true, force: true });
        rmSync(fakeRsyncDir, { recursive: true, force: true });
        rmSync(skillsDev, { recursive: true, force: true });
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!bashAvailable() || !flockAvailable())(
  "sync lock dies with its owner (no orphan holder after the holder is SIGKILLed)",
  async () => {
    const lockDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lockdie-"));
    const home = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lockdie-home-"));
    const dev = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lockdie-dev-"));
    const fakeNpmDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lockdie-npm-"));
    const started = path.join(fakeNpmDir, "started");
    const lock = path.join(lockDir, "workflow-toolkit-sync.lock");
    const syncRuntimeSrc = path.resolve(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "workit-core",
      "src",
      "core",
      "sync-runtime.ts",
    );
    const childCode = `
      import { syncRuntime } from ${JSON.stringify(syncRuntimeSrc)};
      const r = await syncRuntime({});
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    `;
    const env: Record<string, string> = {
      HOME: home,
      XDG_RUNTIME_DIR: lockDir,
      WORKFLOW_TOOLKIT_DEV: dev,
      FAKE_NPM_STARTED: started,
      PATH: `${fakeNpmDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const child = spawn(process.execPath, ["-e", childCode], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const heldFree = (): boolean =>
      spawnSync("bash", ["-c", 'exec 9>"$1"; flock -n 9 || exit 1', "probe", lock]).status === 0;
    try {
      mkdirSync(path.join(dev, "packages/workit-opencode/src"), { recursive: true });
      mkdirSync(path.join(dev, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
      mkdirSync(path.join(dev, "packages/workit-cursor/mcp"), { recursive: true });
      writeFileSync(
        path.join(dev, "packages/workit-opencode/src/plugin.ts"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(fakeNpmDir, "npm"),
        `#!/usr/bin/env bash\ntouch "$FAKE_NPM_STARTED"\nsleep 60\n`,
        { mode: 0o755 },
      );
      for (let i = 0; i < 200 && !existsSync(started); i++) await Bun.sleep(25);
      expect(existsSync(started)).toBe(true); // sync is mid-flight, so the lock is held
      expect(heldFree()).toBe(false); // a second sync must not acquire yet

      child.kill("SIGKILL");
      let free = false;
      for (let i = 0; i < 200; i++) {
        if (heldFree()) {
          free = true;
          break;
        }
        await Bun.sleep(25);
      }
      expect(free).toBe(true); // the lock died with its owner
    } finally {
      child.kill("SIGKILL");
      // Don't await the child's exit event: bun occasionally never fires it
      // for a SIGKILLed child. A short pause lets the child die before the
      // fixture dirs it may still be writing to are removed.
      await Bun.sleep(200);
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(dev, { recursive: true, force: true });
      rmSync(fakeNpmDir, { recursive: true, force: true });
    }
  },
);

function findOnPath(tool: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, tool);
    try {
      require("node:fs").accessSync(candidate);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}
