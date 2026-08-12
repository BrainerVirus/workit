import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
const repoRoot = path.resolve(import.meta.dir, "..", "..");

function makeDependencyFreeCheckout() {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "wf-parity-checkout-"));
  for (const file of ["package.json", "bun.lock"]) {
    cpSync(path.join(repoRoot, file), path.join(checkout, file));
  }
  for (const pkg of ["workit-core", "workit-cursor", "workit-opencode"]) {
    cpSync(path.join(repoRoot, "packages", pkg), path.join(checkout, "packages", pkg), {
      recursive: true,
      filter: (src) =>
        !src.split(path.sep).some((part) => part === "node_modules" || part === "dist"),
    });
  }
  const dist = path.join(checkout, "packages/workit-cursor/dist");
  mkdirSync(dist, { recursive: true });
  for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
    writeFileSync(path.join(dist, entry), "stale\n");
  }
  return checkout;
}

function writeOfflineBunWrapper(binDir: string, name = "selected-runtime") {
  const wrapper = path.join(binDir, name);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--version" ]; then exec "$REAL_BUN" --version; fi
if [ "\${1:-}" = "install" ]; then
  [ "\${2:-}" = "--frozen-lockfile" ] || exit 41
  printf 'install\n' >> "$BUN_LOG"
  [ "\${FAIL_INSTALL:-0}" = "0" ] || exit 42
  mkdir -p "$PWD/node_modules/@brainervirus" "$PWD/node_modules/@modelcontextprotocol"
  ln -s "$PWD/packages/workit-core" "$PWD/node_modules/@brainervirus/workit-core"
  ln -s "$REAL_NODE_MODULES/@modelcontextprotocol/sdk" "$PWD/node_modules/@modelcontextprotocol/sdk"
  ln -s "$REAL_NODE_MODULES/zod" "$PWD/node_modules/zod"
  exit 0
fi
case "\${1:-}" in
  */packages/workit-cursor/scripts/build.ts)
    grep -qx install "$BUN_LOG" || exit 43
    printf 'build\n' >> "$BUN_LOG"
    [ "\${FAIL_BUILD:-0}" = "0" ] || exit 44
    "$REAL_BUN" "$@"
    if [ "\${BAD_OUTPUT:-0}" = "1" ]; then printf '#!/usr/bin/env bun\n' > "$PWD/packages/workit-cursor/dist/mcp-server.js"; fi
    exit 0
    ;;
esac
exec "$REAL_BUN" "$@"
`,
    { mode: 0o755 },
  );
  return wrapper;
}

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
    // B4: concise shell shape — workspace:/provider: only, no raw summary JSON.
    expect(sections["VCS Config"] ?? "").not.toContain('"defaultTargetBranch"');
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
    // verify run from a subdir must inspect the repo root's manifests. git
    // returns the realpath (macOS /var -> /private/var), so compare real-to-real.
    const result = runVerifyProject(subdir);
    expect(result.cwd).toBe(realpathSync(repo));
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
    // Compare real-to-real: git --show-toplevel returns the realpath (macOS).
    const result = runVerifyProject(subdir);
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(realpathSync(repo));
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

test("git context surfaces captured stderr when the cwd is not a git repository", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-nogit-"));
  try {
    const ctx = gitContext(dir);
    expect(ctx.stderr).toContain("not a git repository");
    expect(ctx.exitCode).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// The skills-rsync sub-case wraps the real rsync (REAL_RSYNC) for the
// non-skills copies, so a missing rsync makes the first rsync fail with a
// different error than "skills rsync failed". Skip the whole parity test when
// rsync is unavailable instead of asserting on the wrong error (B7).
test.skipIf(!bashAvailable() || !flockAvailable() || !findOnPath("rsync"))(
  "syncRuntime matches sync-runtime.sh sync and RR-05 failure behavior",
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

      // A dependency-free checkout installs before a real rebuild, replacing stale dist.
      const devHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devhome-"));
      const devLockDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devlock-"));
      const npmBin = mkdtempSync(path.join(os.tmpdir(), "wf-parity-npm-"));
      const dev = makeDependencyFreeCheckout();
      const bunLog = path.join(npmBin, "bun.log");
      const bun = writeOfflineBunWrapper(npmBin);
      const noOtherBunPath = `${npmBin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
      writeFileSync(
        path.join(npmBin, "npm"),
        "#!/usr/bin/env bash\necho 'npm unavailable' >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const devHome2 = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devhome2-"));
      const devLockDir2 = mkdtempSync(path.join(os.tmpdir(), "wf-parity-devlock2-"));
      const noBunHome = mkdtempSync(path.join(os.tmpdir(), "wf-parity-nobun-home-"));
      const noBunLock = mkdtempSync(path.join(os.tmpdir(), "wf-parity-nobun-lock-"));
      const noBunBin = mkdtempSync(path.join(os.tmpdir(), "wf-parity-nobun-bin-"));
      for (const tool of ["flock", "sh"]) {
        const real = findOnPath(tool);
        if (real) symlinkSync(real, path.join(noBunBin, tool));
      }
      try {
        const env = mkEnv({
          HOME: devHome,
          XDG_RUNTIME_DIR: devLockDir,
          WORKFLOW_TOOLKIT_DEV: dev,
          BUN: bun,
          BUN_LOG: bunLog,
          REAL_BUN: process.execPath,
          REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
          PATH: noOtherBunPath,
        });
        const ts = await syncRuntime({ env });
        expect(ts).toEqual({ ok: true });
        expect(readFileSync(bunLog, "utf8")).toBe("install\nbuild\n");
        for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
          const installed = path.join(
            devHome,
            ".cursor/plugins/local/workflow-toolkit/dist",
            entry,
          );
          expect(existsSync(installed), entry).toBe(true);
          expect(readFileSync(installed, "utf8")).toStartWith("#!/usr/bin/env node");
          expect(readFileSync(installed, "utf8")).not.toBe("stale\n");
        }

        const bashEnv = mkEnv({
          HOME: devHome2,
          XDG_RUNTIME_DIR: devLockDir2,
          WORKFLOW_TOOLKIT_DEV: dev,
          BUN: bun,
          BUN_LOG: bunLog,
          REAL_BUN: process.execPath,
          REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
          PATH: noOtherBunPath,
        });
        rmSync(path.join(dev, "node_modules"), { recursive: true, force: true });
        writeFileSync(bunLog, "");
        const bash = runScript(bashEnv);
        expect(bash.status, bash.stderr).toBe(0);
        expect(readFileSync(bunLog, "utf8")).toBe("install\nbuild\n");
        for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
          const installed = path.join(
            devHome2,
            ".cursor/plugins/local/workflow-toolkit/dist",
            entry,
          );
          expect(existsSync(installed), entry).toBe(true);
          expect(readFileSync(installed, "utf8")).toStartWith("#!/usr/bin/env node");
        }

        rmSync(path.join(dev, "node_modules"), { recursive: true, force: true });
        const failedInstall = await syncRuntime({
          env: mkEnv({
            HOME: devHome,
            XDG_RUNTIME_DIR: devLockDir,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            FAIL_INSTALL: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        });
        expect(failedInstall.ok).toBe(false);
        expect("error" in failedInstall && failedInstall.error).toContain(
          "dependency install failed",
        );

        const failedBashInstall = runScript(
          mkEnv({
            HOME: devHome2,
            XDG_RUNTIME_DIR: devLockDir2,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            FAIL_INSTALL: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        );
        expect(failedBashInstall.status).not.toBe(0);
        expect(failedBashInstall.stderr).toContain("dependency install failed");

        mkdirSync(path.join(dev, "node_modules", "@brainervirus"), { recursive: true });
        mkdirSync(path.join(dev, "node_modules", "@modelcontextprotocol"), { recursive: true });
        symlinkSync(
          path.join(dev, "packages/workit-core"),
          path.join(dev, "node_modules/@brainervirus/workit-core"),
        );
        symlinkSync(
          path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk"),
          path.join(dev, "node_modules/@modelcontextprotocol/sdk"),
        );
        symlinkSync(path.join(repoRoot, "node_modules/zod"), path.join(dev, "node_modules/zod"));
        const failedBuild = await syncRuntime({
          env: mkEnv({
            HOME: devHome,
            XDG_RUNTIME_DIR: devLockDir,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            FAIL_BUILD: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        });
        expect(failedBuild.ok).toBe(false);
        expect("error" in failedBuild && failedBuild.error).toContain("adapter build failed");
        const failedBashBuild = runScript(
          mkEnv({
            HOME: devHome2,
            XDG_RUNTIME_DIR: devLockDir2,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            FAIL_BUILD: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        );
        expect(failedBashBuild.status).not.toBe(0);
        expect(failedBashBuild.stderr).toContain("adapter build failed");
        rmSync(path.join(dev, "node_modules"), { recursive: true, force: true });

        const invalidBun = await syncRuntime({
          env: mkEnv({
            HOME: devHome,
            XDG_RUNTIME_DIR: devLockDir,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: path.join(npmBin, "missing-bun"),
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        });
        expect(invalidBun.ok).toBe(false);
        expect("error" in invalidBun && invalidBun.error).toContain("BUN");

        const invalidBashBun = runScript(
          mkEnv({
            HOME: devHome2,
            XDG_RUNTIME_DIR: devLockDir2,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: path.join(npmBin, "missing-bun"),
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        );
        expect(invalidBashBun.status).not.toBe(0);
        expect(invalidBashBun.stderr).toContain("BUN is set but unusable");

        const pathBun = path.join(noBunBin, "bun");
        writeFileSync(pathBun, "#!/usr/bin/env bash\nexit 9\n", { mode: 0o755 });
        const emptyBun = await syncRuntime({
          env: mkEnv({
            HOME: noBunHome,
            XDG_RUNTIME_DIR: noBunLock,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: "",
            PATH: noBunBin,
          }),
        });
        expect("error" in emptyBun && emptyBun.error).not.toContain("BUN is set");

        mkdirSync(path.join(noBunHome, ".bun/bin"), { recursive: true });
        writeFileSync(path.join(noBunHome, ".bun/bin/bun"), "#!/usr/bin/env bash\nexit 8\n", {
          mode: 0o755,
        });
        writeFileSync(pathBun, `#!/usr/bin/env bash\ntouch "${pathBun}.used"\nexit 0\n`, {
          mode: 0o755,
        });
        const brokenHomeBun = await syncRuntime({
          env: mkEnv({
            HOME: noBunHome,
            XDG_RUNTIME_DIR: noBunLock,
            WORKFLOW_TOOLKIT_DEV: dev,
            PATH: noBunBin,
          }),
        });
        expect(brokenHomeBun.ok).toBe(false);
        expect(existsSync(`${pathBun}.used`)).toBe(false);

        mkdirSync(path.join(dev, "node_modules", "@brainervirus"), { recursive: true });
        mkdirSync(path.join(dev, "node_modules", "@modelcontextprotocol"), { recursive: true });
        symlinkSync(
          path.join(dev, "packages/workit-core"),
          path.join(dev, "node_modules/@brainervirus/workit-core"),
        );
        symlinkSync(
          path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk"),
          path.join(dev, "node_modules/@modelcontextprotocol/sdk"),
        );
        symlinkSync(path.join(repoRoot, "node_modules/zod"), path.join(dev, "node_modules/zod"));
        const badOutput = await syncRuntime({
          env: mkEnv({
            HOME: devHome,
            XDG_RUNTIME_DIR: devLockDir,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            BAD_OUTPUT: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        });
        expect(badOutput.ok).toBe(false);
        expect("error" in badOutput && badOutput.error).toContain("invalid dist entry");
        const badBashOutput = runScript(
          mkEnv({
            HOME: devHome2,
            XDG_RUNTIME_DIR: devLockDir2,
            WORKFLOW_TOOLKIT_DEV: dev,
            BUN: bun,
            BUN_LOG: bunLog,
            REAL_BUN: process.execPath,
            REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
            BAD_OUTPUT: "1",
            PATH: `${npmBin}${path.delimiter}${process.env.PATH ?? ""}`,
          }),
        );
        expect(badBashOutput.status).not.toBe(0);
        expect(badBashOutput.stderr).toContain("invalid dist entry");

        rmSync(pathBun, { force: true });
        rmSync(path.join(noBunHome, ".bun/bin/bun"), { force: true });
        const missingBun = await syncRuntime({
          env: mkEnv({
            HOME: noBunHome,
            XDG_RUNTIME_DIR: noBunLock,
            WORKFLOW_TOOLKIT_DEV: dev,
            PATH: noBunBin,
          }),
        });
        expect(missingBun.ok).toBe(false);
        expect("error" in missingBun && missingBun.error).toContain("Bun");
      } finally {
        rmSync(devHome, { recursive: true, force: true });
        rmSync(devLockDir, { recursive: true, force: true });
        rmSync(devHome2, { recursive: true, force: true });
        rmSync(devLockDir2, { recursive: true, force: true });
        rmSync(noBunHome, { recursive: true, force: true });
        rmSync(noBunLock, { recursive: true, force: true });
        rmSync(noBunBin, { recursive: true, force: true });
        rmSync(npmBin, { recursive: true, force: true });
        rmSync(dev, { recursive: true, force: true });
      }

      // Missing filtered build output must fail in both implementations; neither
      // implementation may restore it from the raw core vendor.
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
      mkdirSync(path.join(skillsDev, "packages/workit-cursor/scripts"), { recursive: true });
      mkdirSync(path.join(skillsDev, "packages/workit-cursor/dist"), { recursive: true });
      for (const dependency of ["@brainervirus/workit-core", "@modelcontextprotocol/sdk", "zod"]) {
        mkdirSync(path.join(skillsDev, "node_modules", dependency), { recursive: true });
      }
      mkdirSync(path.join(skillsDev, "packages/workit-core/vendor/superpowers/skills"), {
        recursive: true,
      });
      writeFileSync(
        path.join(skillsDev, "packages/workit-opencode/src/plugin.ts"),
        "export default {};\n",
      );
      writeFileSync(path.join(skillsDev, "packages/workit-cursor/scripts/build.ts"), "// build\n");
      const skillsBun = path.join(fakeRsyncDir, "bun");
      writeFileSync(skillsBun, '#!/usr/bin/env bash\n[[ "${1:-}" != */skill-manifests.ts ]]\n', {
        mode: 0o755,
      });
      for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
        writeFileSync(
          path.join(skillsDev, "packages/workit-cursor/dist", entry),
          "#!/usr/bin/env node\n",
        );
      }
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
            BUN: skillsBun,
            PATH: `${fakeRsyncDir}${path.delimiter}${process.env.PATH ?? ""}`,
            REAL_RSYNC: realRsync ?? "rsync",
          }),
        });
        expect(tsSkills.ok).toBe(false);
        expect("error" in tsSkills && tsSkills.error).toContain("Cursor Workit skills mismatch");

        const bashSkills = runScript(
          mkEnv({
            HOME: skillsBashHome,
            XDG_RUNTIME_DIR: skillsBashLock,
            WORKFLOW_TOOLKIT_DEV: skillsDev,
            BUN: skillsBun,
            PATH: `${fakeRsyncDir}${path.delimiter}${process.env.PATH ?? ""}`,
            REAL_RSYNC: realRsync ?? "rsync",
          }),
        );
        expect(bashSkills.status).not.toBe(0);
        expect(bashSkills.stderr).toContain("Cursor skill validation failed");
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
    const fakeRsyncDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-lockdie-rsync-"));
    const started = path.join(fakeRsyncDir, "started");
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
      FAKE_RSYNC_STARTED: started,
      PATH: `${fakeRsyncDir}${path.delimiter}${process.env.PATH ?? ""}`,
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
      mkdirSync(path.join(dev, "packages/workit-cursor/scripts"), { recursive: true });
      mkdirSync(path.join(dev, "packages/workit-cursor/dist"), { recursive: true });
      for (const dependency of ["@brainervirus/workit-core", "@modelcontextprotocol/sdk", "zod"]) {
        mkdirSync(path.join(dev, "node_modules", dependency), { recursive: true });
      }
      writeFileSync(
        path.join(dev, "packages/workit-opencode/src/plugin.ts"),
        "export default {};\n",
      );
      writeFileSync(path.join(dev, "packages/workit-cursor/scripts/build.ts"), "// build\n");
      const lockBun = path.join(fakeRsyncDir, "bun");
      writeFileSync(lockBun, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      env.BUN = lockBun;
      for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
        writeFileSync(
          path.join(dev, "packages/workit-cursor/dist", entry),
          "#!/usr/bin/env node\n",
        );
      }
      writeFileSync(
        path.join(fakeRsyncDir, "rsync"),
        `#!/usr/bin/env bash\ntouch "$FAKE_RSYNC_STARTED"\nsleep 60\n`,
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
      rmSync(fakeRsyncDir, { recursive: true, force: true });
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
