import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
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
import { fileURLToPath } from "node:url";
import { envWithHome, withConfigDir } from "../shared/helpers/env";

// Parity tests for scripts/vcs/config.sh resolve/load, pr-create.sh missing-CLI guard,
// pr-create.sh --build-body issue linking, and pr-ready-context.sh VCS Config section.
// Mirrors src/core/workspaces.ts semantics
// (first-wins globs, missing/malformed workspaces.json -> no workspace, never error).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const GLOBAL_VCS = { provider: "github", defaultTargetBranch: "main" };

const scriptTools = (): boolean => {
  if (process.platform === "win32") return false; // win32 CI has no bash
  for (const [cmd, args] of [
    ["bash", ["--version"]],
    ["python3", ["--version"]],
  ] as const) {
    if (spawnSync(cmd, args, { encoding: "utf8" }).status !== 0) return false;
  }
  return true;
};

// temp HOME so config.sh defaults ($HOME/.config/workflow-toolkit/*) stay isolated
const run = (args: string[], opts: { cwd?: string; env: Record<string, string> }) =>
  spawnSync("bash", [path.join(repoRoot, args[0]), ...args.slice(1)], {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env,
    encoding: "utf8",
  });

const workspacesJson = (
  glob: string,
  provider: string,
  extra?: { vcs?: Record<string, unknown>; youtrack?: Record<string, unknown> },
): string =>
  JSON.stringify({
    workspaces: [
      {
        name: "work",
        glob,
        vcs: { provider, ...extra?.vcs },
        youtrack: extra?.youtrack ?? {},
      },
    ],
  });

test("config.sh resolve: workspace match wins over global vcs.json (work -> gitlab, personal -> github)", () => {
  if (!scriptTools()) return;
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "sixbell", "repo"), { recursive: true });
  mkdirSync(path.join(base, "personal", "some-app"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": JSON.stringify({
      workspaces: [
        {
          name: "work",
          glob: `${base}/work/**`,
          vcs: { provider: "gitlab" },
          youtrack: { link_issues: true },
        },
        {
          name: "personal",
          glob: `${base}/personal/**`,
          vcs: { provider: "github" },
          issues: { provider: "github", link_on_pr: true },
        },
      ],
    }),
  });
  try {
    const env = envWithHome(home);

    const work = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: path.join(base, "work", "sixbell", "repo"),
      env,
    });
    expect(work.status).toBe(0);
    const w = JSON.parse(work.stdout);
    expect(w.ok).toBe(true);
    expect(w.workspace_name).toBe("work");
    expect(w.provider).toBe("gitlab");
    expect(w.defaultTargetBranch).toBe("main"); // workspace has none -> global fallback
    expect(w.link_issues).toBe(true);
    expect(w.youtrack_base_url).toBeNull();
    expect(w.issues_provider).toBeNull(); // youtrack workspace: no github issues keys
    expect(w.link_on_pr).toBeNull();

    const personal = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: path.join(base, "personal", "some-app"),
      env,
    });
    expect(personal.status).toBe(0);
    const p = JSON.parse(personal.stdout);
    expect(p.workspace_name).toBe("personal");
    expect(p.provider).toBe("github");
    expect(p.link_issues).toBeNull();
    expect(p.youtrack_base_url).toBeNull();
    expect(p.issues_provider).toBe("github");
    expect(p.link_on_pr).toBe(true);
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

    const noMatch = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: unmatched,
      env,
    });
    expect(noMatch.status).toBe(0);
    const r = JSON.parse(noMatch.stdout);
    expect(r.workspace_name).toBeNull();
    expect(r.provider).toBe("github");
    expect(r.defaultTargetBranch).toBe("main");
    expect(r.link_issues).toBeNull();

    writeFileSync(path.join(home, ".config", "workflow-toolkit", "workspaces.json"), "{ nope !!");
    const malformed = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: unmatched,
      env,
    });
    expect(malformed.status).toBe(0);
    expect(JSON.parse(malformed.stdout).workspace_name).toBeNull();
  } finally {
    cleanup();
  }
});

test("config.sh resolve: WORKFLOW_TOOLKIT_CONFIG dir is honored for vcs.json + workspaces.json (TS chain parity)", () => {
  if (!scriptTools()) return;
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-chain-"));
  writeFileSync(path.join(cfgDir, "vcs.json"), JSON.stringify(GLOBAL_VCS), "utf8");
  writeFileSync(
    path.join(cfgDir, "workspaces.json"),
    workspacesJson(`${base}/work/**`, "gitlab"),
    "utf8",
  );
  const home = mkdtempSync(path.join(os.tmpdir(), "wf-ws-home-"));
  try {
    const env = envWithHome(home, { WORKFLOW_TOOLKIT_CONFIG: cfgDir });
    const r = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: path.join(base, "work", "repo"),
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.workspace_name).toBe("work");
    expect(out.provider).toBe("gitlab");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("config.sh resolve: WORKFLOW_WORKSPACE_ROOT overrides the cwd", () => {
  if (!scriptTools()) return;
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": workspacesJson(`${base}/work/**`, "gitlab"),
  });
  try {
    const env = envWithHome(home, { WORKFLOW_WORKSPACE_ROOT: path.join(base, "work", "repo") });
    mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    const r = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: path.join(home, "elsewhere"),
      env,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).workspace_name).toBe("work");
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("config.sh resolve: catchall ** matches a drive-letter WORKFLOW_WORKSPACE_ROOT (TS parity)", () => {
  if (!scriptTools()) return;
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": workspacesJson("**", "gitlab"),
  });
  try {
    const env = envWithHome(home, {
      WORKFLOW_WORKSPACE_ROOT: "D:/a/workflow-toolkit/workflow-toolkit",
    });
    const r = run(["packages/workit-core/scripts/vcs/config.sh", "resolve"], {
      cwd: repoRoot,
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).workspace_name).toBe("work");
  } finally {
    cleanup();
  }
});

test("config.sh load: merges the resolved workspace over global vcs.json", () => {
  if (!scriptTools()) return;
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  mkdirSync(path.join(base, "personal", "app"), { recursive: true });
  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify(GLOBAL_VCS),
    "workspaces.json": JSON.stringify({
      workspaces: [
        {
          name: "work",
          glob: `${base}/work/**`,
          vcs: { provider: "gitlab" },
          youtrack: { link_issues: true },
        },
        {
          name: "personal",
          glob: `${base}/personal/**`,
          vcs: { provider: "github" },
          issues: { provider: "github", link_on_pr: true },
        },
      ],
    }),
  });
  try {
    const env = envWithHome(home);

    const matched = run(["packages/workit-core/scripts/vcs/config.sh", "load"], {
      cwd: path.join(base, "work", "repo"),
      env,
    });
    expect(matched.status, matched.stderr).toBe(0);
    const m = JSON.parse(matched.stdout);
    expect(m.ok).toBe(true);
    expect(m.provider).toBe("gitlab"); // workspace wins over global github
    expect(m.workspace_name).toBe("work");
    expect(m.link_issues).toBe(true);
    expect(m.issues_provider).toBeNull();
    expect(m.link_on_pr).toBeNull();
    expect(m.defaultTargetBranch).toBe("main"); // workspace has none -> global
    expect(m.tokenReady).toBe(false);

    const gh = run(["packages/workit-core/scripts/vcs/config.sh", "load"], {
      cwd: path.join(base, "personal", "app"),
      env,
    });
    expect(gh.status, gh.stderr).toBe(0);
    const g = JSON.parse(gh.stdout);
    expect(g.provider).toBe("github");
    expect(g.workspace_name).toBe("personal");
    expect(g.issues_provider).toBe("github");
    expect(g.link_on_pr).toBe(true);
    expect(g.link_issues).toBeNull();
    expect(g.youtrack_base_url).toBeNull();

    mkdirSync(path.join(home, "elsewhere"), { recursive: true });
    const noMatch = run(["packages/workit-core/scripts/vcs/config.sh", "load"], {
      cwd: path.join(home, "elsewhere"),
      env,
    });
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
  const realPy = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  });
  if (realPy.status === 0 && realPy.stdout.trim())
    symlinkSync(realPy.stdout.trim(), path.join(stubBin, "python3"));
  const cleanPath = pathDirs.filter(
    (d) => d && !existsSync(path.join(d, "gh")) && !existsSync(path.join(d, "glab")),
  );

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
      const r = run(["packages/workit-core/scripts/pr-create.sh"], { cwd: repoRoot, env });
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
    const r = run(["packages/workit-core/scripts/pr-ready-context.sh", "HEAD~1..HEAD"], {
      cwd: repoRoot,
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("workspace: work");
    expect(r.stdout).toContain("provider: gitlab");
    expect(r.stdout).not.toContain("vcs: not configured");
  } finally {
    cleanup();
  }
});

test("pr-ready-context.sh uses the workspace target branch", () => {
  if (!scriptTools()) return;
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-pr-base-")));
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Workflow Test"]);
  git(["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "base"]);
  git(["branch", "develop"]);
  writeFileSync(path.join(repo, "main.txt"), "main\n");
  git(["add", "main.txt"]);
  git(["commit", "-q", "-m", "main base"]);
  git(["checkout", "-q", "-b", "feature/workspace-base"]);
  writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(["add", "feature.txt"]);
  git(["commit", "-q", "-m", "feature change"]);

  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
    "workspaces.json": workspacesJson(`${repo}/**`, "github", {
      vcs: { defaultTargetBranch: "main" },
    }),
  });
  try {
    const result = run(["packages/workit-core/scripts/pr-ready-context.sh"], {
      cwd: repo,
      env: envWithHome(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("base_ref: main");
    expect(result.stdout).toContain("range: main..HEAD");
    expect(result.stdout).toContain("feature change");
    expect(result.stdout).not.toContain("main base");
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// pr-create.sh --build-body: pure body builder — no CLI guard, no network (git remote parsed only when GH_REPO is unset).
const buildBody = (extra: Record<string, string>, cwd?: string): string => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("WORKFLOW_")) continue;
    env[k] = v;
  }
  const r = run(["packages/workit-core/scripts/pr-create.sh", "--build-body"], {
    cwd: cwd ?? repoRoot,
    env: { ...env, ...extra },
  });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { body: string }).body;
};

test("pr-create.sh --build-body: branch-derived issue id appends Related to line", () => {
  if (!scriptTools()) return;
  expect(
    buildBody({
      BRANCH: "feature/IRP-123-fix",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
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
  expect(
    buildBody({
      BODY: "Same body",
      BRANCH: "feature/IRP-123-fix",
      LINK_ISSUES: "false",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("Same body");
  expect(
    buildBody({
      BODY: "Same body",
      BRANCH: "feature/IRP-123-fix",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("Same body");
});

test("pr-create.sh --build-body: version-like tokens are not linked (POSTGRES-16, HTTP-3), issue refs are", () => {
  if (!scriptTools()) return;
  expect(
    buildBody({
      BRANCH: "feature/POSTGRES-16-upgrade",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("");
  expect(
    buildBody({
      BRANCH: "release/HTTP-3",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("");
  expect(
    buildBody({
      BRANCH: "feature/IRP-123-fix",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("Related to: https://yt.example.com/issue/IRP-123");
});

test("pr-create.sh --build-body: explicit WORKFLOW_YT_ISSUE wins over branch-derived id", () => {
  if (!scriptTools()) return;
  expect(
    buildBody({
      BRANCH: "feature/IRP-123-fix",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
      WORKFLOW_YT_ISSUE: "NSAT-9",
    }),
  ).toBe("Related to: https://yt.example.com/issue/NSAT-9");
});

test("pr-create.sh --build-body: no base URL or no derivable id -> no Related to line", () => {
  if (!scriptTools()) return;
  expect(buildBody({ BODY: "No link", BRANCH: "feature/IRP-123-fix", LINK_ISSUES: "true" })).toBe(
    "No link",
  );
  expect(
    buildBody({
      BODY: "No link",
      BRANCH: "feature/maintenance",
      LINK_ISSUES: "true",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("No link");
});

test("pr-create.sh --build-body: explicit WORKFLOW_GH_ISSUE closes/related (default closes, # prefix stripped)", () => {
  if (!scriptTools()) return;
  expect(buildBody({ GH_LINK_ON_PR: "true", WORKFLOW_GH_ISSUE: "42" })).toBe("Closes #42");
  expect(
    buildBody({ BODY: "Existing body", GH_LINK_ON_PR: "true", WORKFLOW_GH_ISSUE: "#42" }),
  ).toBe("Existing body\n\nCloses #42");
  expect(
    buildBody({
      GH_LINK_ON_PR: "true",
      WORKFLOW_GH_ISSUE: "https://github.com/acme/app/issues/42",
    }),
  ).toBe("Closes #42");
  expect(
    buildBody({
      GH_LINK_ON_PR: "true",
      WORKFLOW_GH_ISSUE: "42",
      WORKFLOW_GH_ISSUE_RELATION: "related",
      GH_REPO: "acme/app",
    }),
  ).toBe("Related to #42 — https://github.com/acme/app/issues/42");
  expect(buildBody({ GH_LINK_ON_PR: "true", WORKFLOW_GH_ISSUE: "42", BODY: "" })).toBe(
    "Closes #42",
  );
});

test("pr-create.sh --build-body: branch-derived pure-number id auto-links (feature/42-title -> Closes #42)", () => {
  if (!scriptTools()) return;
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "42-title" })).toBe("Closes #42");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/foo" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "false", BRANCH: "feature/42-title" })).toBe("");
  // version tokens never link (release/1.2.3, backport/8.0.1, release/2024.1)
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "release/1.2.3" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "backport/8.0.1" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "release/2024.1" })).toBe("");
});

test("pr-create.sh --build-body: owner/repo parsed from git remote get-url origin; absent remote -> Related line without URL", () => {
  if (!scriptTools()) return;
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-gh-repo-")));
  const bareDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-gh-bare-")));
  try {
    for (const [cmd, args] of [
      ["git", ["init", "-q"]],
      ["git", ["remote", "add", "origin", "git@github.com:acme/app.git"]],
    ] as const) {
      expect(spawnSync(cmd, args, { cwd: repoDir, encoding: "utf8" }).status).toBe(0);
    }
    expect(
      buildBody(
        { GH_LINK_ON_PR: "true", WORKFLOW_GH_ISSUE: "42", WORKFLOW_GH_ISSUE_RELATION: "related" },
        repoDir,
      ),
    ).toBe("Related to #42 — https://github.com/acme/app/issues/42");
    expect(
      buildBody(
        { GH_LINK_ON_PR: "true", WORKFLOW_GH_ISSUE: "42", WORKFLOW_GH_ISSUE_RELATION: "related" },
        bareDir,
      ),
    ).toBe("Related to #42");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  }
});

test("pr-create.sh create: cfg-driven wiring emits Closes #N into the real gh invocation", () => {
  if (!scriptTools()) return;
  // stub gh records its args and returns a fake PR URL; the rest of PATH mirrors the CLI-guard test
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-bin-"));
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-gh-repo-")));
  const logFile = path.join(stubBin, "args.txt");
  writeFileSync(
    path.join(stubBin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\necho "https://github.com/o/r/pull/1"\n`,
    { mode: 0o755 },
  );
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
  const realPy = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  });
  if (realPy.status === 0 && realPy.stdout.trim())
    symlinkSync(realPy.stdout.trim(), path.join(stubBin, "python3"));
  const cleanPath = pathDirs.filter(
    (d) => d && !existsSync(path.join(d, "gh")) && !existsSync(path.join(d, "glab")),
  );

  const { home, cleanup } = withConfigDir({
    "vcs.json": JSON.stringify({ provider: "github", defaultTargetBranch: "main" }),
    "workspaces.json": JSON.stringify({
      workspaces: [
        {
          name: "work",
          glob: `${repoDir}/**`,
          vcs: { provider: "github" },
          issues: { provider: "github", link_on_pr: true },
        },
      ],
    }),
    "github.token": "test-token-123",
  });
  try {
    for (const [cmd, args] of [
      ["git", ["init", "-q"]],
      ["git", ["remote", "add", "origin", "git@github.com:o/r.git"]],
    ] as const) {
      expect(spawnSync(cmd, args, { cwd: repoDir, encoding: "utf8" }).status).toBe(0);
    }
    const env = envWithHome(home, {
      PATH: `${stubBin}:${cleanPath.join(":")}`,
      WF_PR_CONFIRMED: "true",
      WF_PR_TITLE: "Test title",
      WORKFLOW_GH_ISSUE: "42",
    });
    const r = run(["packages/workit-core/scripts/pr-create.sh"], { cwd: repoDir, env });
    expect(r.status, `create failed: ${r.stdout} ${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("Closes #42");
  } finally {
    cleanup();
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
