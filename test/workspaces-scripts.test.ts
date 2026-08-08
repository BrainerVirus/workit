import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Parity tests for scripts/vcs/config.sh resolve/load, pr-create.sh missing-CLI guard,
// pr-create.sh --build-body issue linking, and pr-ready-context.sh VCS Config section.
// Mirrors src/core/workspaces.ts semantics
// (first-wins globs, missing/malformed workspaces.json -> no workspace, never error).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GLOBAL_VCS = { provider: "github", defaultTargetBranch: "main" };

const scriptTools = (): boolean => {
  if (process.platform === "win32") return false; // win32 CI has no bash
  for (const [cmd, args] of [["bash", ["--version"]], ["python3", ["--version"]]] as const) {
    if (spawnSync(cmd, args, { encoding: "utf8" }).status !== 0) return false;
  }
  return true;
};

// temp HOME so config.sh defaults ($HOME/.config/workflow-toolkit/*) stay isolated
const withConfigDir = (files: Record<string, string>) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wf-ws-scripts-"));
  const cfgDir = path.join(home, ".config", "workflow-toolkit");
  mkdirSync(cfgDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(cfgDir, name), content, "utf8");
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

const envWithHome = (home: string, extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^WORKFLOW_(VCS|TOOLKIT_CONFIG)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  return { ...env, ...extra };
};

const run = (args: string[], opts: { cwd?: string; env: Record<string, string> }) =>
  spawnSync("bash", [path.join(repoRoot, args[0]), ...args.slice(1)], { cwd: opts.cwd ?? repoRoot, env: opts.env, encoding: "utf8" });

const workspacesJson = (glob: string, provider: string, extra?: Record<string, unknown>): string =>
  JSON.stringify({
    workspaces: [
      {
        name: "work",
        glob,
        vcs: { provider, ...(extra?.vcs ?? {}) },
        youtrack: extra?.youtrack ?? {},
      },
    ],
  });

test("config.sh resolve: workspace match wins over global vcs.json (work -> gitlab, personal -> github)", () => {
  if (!scriptTools()) return;
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-"));
  mkdirSync(path.join(base, "work", "sixbell", "repo"), { recursive: true });
  mkdirSync(path.join(base, "personal", "some-app"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": JSON.stringify({
      workspaces: [
        { name: "work", glob: `${base}/work/**`, vcs: { provider: "gitlab" }, youtrack: { link_issues: true } },
        { name: "personal", glob: `${base}/personal/**`, vcs: { provider: "github" } },
      ],
    }),
  });
  try {
    const env = envWithHome(home);

    const work = run(["scripts/vcs/config.sh", "resolve"], { cwd: path.join(base, "work", "sixbell", "repo"), env });
    expect(work.status).toBe(0);
    const w = JSON.parse(work.stdout);
    expect(w.ok).toBe(true);
    expect(w.workspace_name).toBe("work");
    expect(w.provider).toBe("gitlab");
    expect(w.defaultTargetBranch).toBe("main"); // workspace has none -> global fallback
    expect(w.link_issues).toBe(true);
    expect(w.youtrack_base_url).toBeNull();

    const personal = run(["scripts/vcs/config.sh", "resolve"], { cwd: path.join(base, "personal", "some-app"), env });
    expect(personal.status).toBe(0);
    const p = JSON.parse(personal.stdout);
    expect(p.workspace_name).toBe("personal");
    expect(p.provider).toBe("github");
    expect(p.link_issues).toBeNull();
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("config.sh resolve: unmatched cwd falls back to global vcs.json; missing/malformed workspaces.json -> no workspace, no error", () => {
  if (!scriptTools()) return;
  const { home, cleanup } = withConfigDir({ "vcs.json": JSON.stringify(GLOBAL_VCS) });
  try {
    const env = envWithHome(home);
    const unmatched = path.join(home, "elsewhere");
    mkdirSync(unmatched, { recursive: true });

    const noMatch = run(["scripts/vcs/config.sh", "resolve"], { cwd: unmatched, env });
    expect(noMatch.status).toBe(0);
    const r = JSON.parse(noMatch.stdout);
    expect(r.workspace_name).toBeNull();
    expect(r.provider).toBe("github");
    expect(r.defaultTargetBranch).toBe("main");
    expect(r.link_issues).toBeNull();

    writeFileSync(path.join(home, ".config", "workflow-toolkit", "workspaces.json"), "{ nope !!");
    const malformed = run(["scripts/vcs/config.sh", "resolve"], { cwd: unmatched, env });
    expect(malformed.status).toBe(0);
    expect(JSON.parse(malformed.stdout).workspace_name).toBeNull();
  } finally {
    cleanup();
  }
});

test("config.sh resolve: WORKFLOW_WORKSPACE_ROOT overrides the cwd", () => {
  if (!scriptTools()) return;
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-"));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": workspacesJson(`${base}/work/**`, "gitlab"),
  });
  try {
    const env = envWithHome(home, { WORKFLOW_WORKSPACE_ROOT: path.join(base, "work", "repo") });
    mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    const r = run(["scripts/vcs/config.sh", "resolve"], { cwd: path.join(home, "elsewhere"), env });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).workspace_name).toBe("work");
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("config.sh load: merges the resolved workspace over global vcs.json", () => {
  if (!scriptTools()) return;
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-"));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": JSON.stringify({
      workspaces: [
        { name: "work", glob: `${base}/work/**`, vcs: { provider: "gitlab" }, youtrack: { link_issues: true } },
      ],
    }),
  });
  try {
    const env = envWithHome(home);

    const matched = run(["scripts/vcs/config.sh", "load"], { cwd: path.join(base, "work", "repo"), env });
    expect(matched.status, matched.stderr).toBe(0);
    const m = JSON.parse(matched.stdout);
    expect(m.ok).toBe(true);
    expect(m.provider).toBe("gitlab"); // workspace wins over global github
    expect(m.workspace_name).toBe("work");
    expect(m.link_issues).toBe(true);
    expect(m.defaultTargetBranch).toBe("main"); // workspace has none -> global
    expect(m.tokenReady).toBe(false);

    mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    const noMatch = run(["scripts/vcs/config.sh", "load"], { cwd: path.join(home, "elsewhere"), env });
    expect(noMatch.status, noMatch.stderr).toBe(0);
    const n = JSON.parse(noMatch.stdout);
    expect(n.provider).toBe("github");
    expect(n.workspace_name).toBeNull();
    expect(n.link_issues).toBeNull();
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("pr-create.sh: missing gh/glab on PATH -> structured error with official install URL", () => {
  if (!scriptTools()) return;
  // stub bin: real bash/git/python3/... without gh/glab, then drop any PATH dir containing gh/glab
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-bin-"));
  const pathDirs = (process.env.PATH ?? "").split(":");
  const findOnPath = (tool: string): string | null => {
    for (const dir of pathDirs) {
      const real = path.join(dir, tool);
      if (dir && existsSync(real)) return real;
    }
    return null;
  };
  for (const tool of ["bash", "git", "dirname", "env", "sh"]) {
    const real = findOnPath(tool);
    if (real) symlinkSync(real, path.join(stubBin, tool));
  }
  // pyenv shims must not be symlinked (SHIM_PATH breaks) — resolve the real interpreter
  const realPy = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (realPy.status === 0 && realPy.stdout.trim()) symlinkSync(realPy.stdout.trim(), path.join(stubBin, "python3"));
  const cleanPath = pathDirs.filter((d) => d && !existsSync(path.join(d, "gh")) && !existsSync(path.join(d, "glab")));

  for (const [provider, cli, url] of [
    ["github", "gh", "https://cli.github.com"],
    ["gitlab", "glab", "https://gitlab.com/gitlab-org/cli"],
  ] as const) {
    const { home, cleanup } = withConfigDir({
      "vcs.json": JSON.stringify({ provider: "github" }),
      "workspaces.json": workspacesJson("**", provider),
      "github.token": "test-token-123",
      "gitlab.token": "test-token-123",
    });
    try {
      const env = envWithHome(home, {
        PATH: `${stubBin}:${cleanPath.join(":")}`,
        WF_PR_CONFIRMED: "true",
        WF_PR_TITLE: "Test title",
      });
      const r = run(["scripts/pr-create.sh"], { cwd: repoRoot, env });
      expect(r.status, `expected exit 1 for missing ${cli}: ${r.stdout} ${r.stderr}`).toBe(1);
      const err = JSON.parse(r.stdout);
      expect(err.ok).toBe(false);
      expect(err.cli_missing).toBe(true);
      expect(err.install_url).toBe(url);
      expect(err.error).toContain(`workflow CLI missing: ${cli}`);
      expect(err.error).toContain(`required for ${provider}`);
      expect(r.stderr).not.toContain("FileNotFoundError");
    } finally {
      cleanup();
    }
  }
  rmSync(stubBin, { recursive: true, force: true });
});

test("pr-ready-context.sh: VCS Config section reports workspace + provider", () => {
  if (!scriptTools()) return;
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": workspacesJson("**", "gitlab"),
  });
  try {
    const env = envWithHome(home); // no token file -> merged-style exits without network
    const r = run(["scripts/pr-ready-context.sh", "HEAD~1..HEAD"], { cwd: repoRoot, env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("workspace: work");
    expect(r.stdout).toContain("provider: gitlab");
    expect(r.stdout).not.toContain("vcs: not configured");
  } finally {
    cleanup();
  }
});

// pr-create.sh --build-body: pure body builder — no git state, no CLI guard, no network.
const buildBody = (extra: Record<string, string>): string => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^WORKFLOW_/.test(k)) continue;
    env[k] = v;
  }
  const r = run(["scripts/pr-create.sh", "--build-body"], {
    cwd: repoRoot,
    env: { ...env, ...extra },
  });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { body: string }).body;
};

test("pr-create.sh --build-body: branch-derived issue id appends Related to line", () => {
  if (!scriptTools()) return;
  expect(
    buildBody({ BRANCH: "feature/IRP-123-fix", LINK_ISSUES: "true", YT_BASE_URL: "https://yt.example.com" }),
  ).toBe("Related to: https://yt.example.com/issue/IRP-123");
  expect(
    buildBody({
      BODY: "Existing body",
      BRANCH: "feature/IRP-123-fix",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("Existing body\n\nRelated to: https://yt.example.com/issue/IRP-123");
});

test("pr-create.sh --build-body: link_issues false or absent -> body unchanged", () => {
  if (!scriptTools()) return;
  expect(buildBody({ BODY: "Same body", BRANCH: "feature/IRP-123-fix", LINK_ISSUES: "false", YT_BASE_URL: "https://yt.example.com" })).toBe("Same body");
  expect(buildBody({ BODY: "Same body", BRANCH: "feature/IRP-123-fix", YT_BASE_URL: "https://yt.example.com" })).toBe("Same body");
});

test("pr-create.sh --build-body: explicit YT_ISSUE wins over branch-derived id", () => {
  if (!scriptTools()) return;
  expect(
    buildBody({ BRANCH: "feature/IRP-123-fix", LINK_ISSUES: "true", YT_BASE_URL: "https://yt.example.com", YT_ISSUE: "NSAT-9" }),
  ).toBe("Related to: https://yt.example.com/issue/NSAT-9");
});

test("pr-create.sh --build-body: no base URL or no derivable id -> no Related to line", () => {
  if (!scriptTools()) return;
  expect(buildBody({ BODY: "No link", BRANCH: "feature/IRP-123-fix", LINK_ISSUES: "true" })).toBe("No link");
  expect(buildBody({ BODY: "No link", BRANCH: "feature/maintenance", LINK_ISSUES: "true", YT_BASE_URL: "https://yt.example.com" })).toBe("No link");
});
