import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "@/packages/workit-core/src/core/repo-context";
import { gitContext } from "@/packages/workit-core/src/core/git";
import { youTrackApi } from "@/packages/workit-core/src/core/youtrack";

/** Split context stdout on `## Section` headers (the shell print_section shape). */
const parseSections = (stdout: string): Record<string, string> => {
  const sections: Record<string, string> = {};
  for (const part of stdout.split(/\n## /).slice(1)) {
    const nl = part.indexOf("\n");
    sections[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return sections;
};

const parseKeyValueLines = (text: string, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n"))
    for (const key of keys)
      if (line.startsWith(`${key}: `)) out[key] = line.slice(key.length + 2).trim();
  return out;
};

// Parity between the TS runtime ports and the maintained shell behavior they
// replaced. Fixtures below were captured from the real scripts before the shell
// port: the context generators must reproduce the same parsed sections and
// error text.

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

test(
  "defaultBase prefers main then develop; rangeArgOrDefault appends ...HEAD",
  () => {
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
  },
  { timeout: 60_000 },
);

test(
  "branch classification and current branch match the shell predicates",
  () => {
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
  },
  { timeout: 60_000 },
);

test.skipIf(process.platform === "win32")(
  "resolvePrBranchContext yields the branch-exclusive range the shell produced",
  () => {
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
  },
  { timeout: 60_000 },
);

test.skipIf(process.platform === "win32")(
  "pr-ready-context sections match the shell output (auto branch-exclusive range)",
  () => {
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
      expect(sections["Merged PR Style"] ?? "").toContain("no origin remote");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test.skipIf(process.platform === "win32")(
  "pr-ready-context with an explicit range skips the branch-exclusive fields",
  () => {
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
  },
  { timeout: 60_000 },
);

test.skipIf(process.platform === "win32")(
  "pr-ready-context errors on protected branches with the shell message",
  () => {
    const { repo } = buildFixtureRepo();
    try {
      spawnSync("git", ["checkout", "-q", "main"], { cwd: repo });
      const result = withGitLabConfig(() => prReadyContext(repo));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot build PR context on protected branch main");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test(
  "changelog-context sections match the shell output",
  () => {
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
  },
  { timeout: 60_000 },
);

test(
  "docs-refresh-context sections match the shell output",
  () => {
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
  },
  { timeout: 60_000 },
);

test(
  "release-notes-context requires a range and reproduces the shell sections",
  () => {
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
  },
  { timeout: 60_000 },
);

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

test(
  "git context surfaces captured stderr when the cwd is not a git repository",
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-nogit-"));
    try {
      const ctx = gitContext(dir);
      expect(ctx.stderr).toContain("not a git repository");
      expect(ctx.exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "PATH scanning uses path.delimiter (Windows-safe) not a literal colon",
  () => {
    const prCreateSource = readFileSync(
      path.resolve(import.meta.dir, "..", "..", "packages", "workit-core", "src/core/pr-create.ts"),
      "utf8",
    );
    expect(prCreateSource).toContain("split(path.delimiter)");
    // Functional delimiter coverage lives in workspaces-scripts.test.ts: the
    // missing-CLI guard runs whichOnPath over a path.delimiter-joined PATH.
  },
  { timeout: 60_000 },
);

test(
  "YouTrack API uses fetch (not the curl binary) and never leaks the token",
  async () => {
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
      seenAuth = String(
        (init as { headers?: Record<string, string> })?.headers?.Authorization ?? "",
      );
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
  },
  { timeout: 60_000 },
);

test(
  "no runtime source spawns curl anymore",
  () => {
    const coreSrc = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core", "src");
    const youtrack = readFileSync(path.join(coreSrc, "core/youtrack.ts"), "utf8");
    expect(youtrack).not.toMatch(/spawnSync\(\s*"curl"/);
    const vcs = readFileSync(path.join(coreSrc, "core/vcs-config.ts"), "utf8");
    expect(vcs).not.toMatch(/spawnSync\(\s*"curl"/);
  },
  { timeout: 60_000 },
);
