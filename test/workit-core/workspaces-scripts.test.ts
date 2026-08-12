import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vcsConfig } from "../../packages/workit-core/src/core/vcs-config";
import { parseSections } from "../../packages/workit-core/src/core/parse-sections";
import { prBuildBody, prCreate } from "../../packages/workit-core/src/core/pr-create";
import { validateWorkspaceGlob } from "../../packages/workit-core/src/core/workspaces";
import {
  prReadyContext,
  resolvePrBranchContext,
} from "../../packages/workit-core/src/core/repo-context";
import { writeWorkspaces } from "../../packages/workit-cli/src/logic";
import { stubCli } from "../shared/helpers/stub-cli";

// Parity tests for the TS ports of scripts/vcs/config.sh resolve/load, pr-create.sh
// missing-CLI guard, pr-create.sh --build-body issue linking, and pr-ready-context.sh
// VCS Config section. Mirrors src/core/workspaces.ts semantics
// (first-wins globs, missing/malformed workspaces.json -> no workspace, never error).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const GLOBAL_VCS = { provider: "github", defaultTargetBranch: "main" };

const ENV_KEYS = [
  "HOME",
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

// Config files land in <xdg>/workflow-toolkit (the legacy dir); the shared config
// migration copies them into <xdg>/workit, which vcsConfig reads via XDG_CONFIG_HOME.
const withConfigFiles = <T>(
  files: Record<string, string>,
  overrides: Record<string, string | undefined> = {},
  fn: () => T,
): T => {
  const xdg = mkdtempSync(path.join(os.tmpdir(), "wf-ws-xdg-"));
  const legacy = path.join(xdg, "workflow-toolkit");
  mkdirSync(legacy, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(legacy, name), content, "utf8");
  }
  return withEnv({ XDG_CONFIG_HOME: xdg, ...overrides }, () => {
    try {
      return fn();
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
};

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
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "sixbell", "repo"), { recursive: true });
  mkdirSync(path.join(base, "personal", "some-app"), { recursive: true });
  try {
    const w = withConfigFiles(
      {
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
      },
      {},
      () => vcsConfig("resolve", path.join(base, "work", "sixbell", "repo")),
    );
    expect(w.ok).toBe(true);
    expect(w.workspace_name).toBe("work");
    expect(w.provider).toBe("gitlab");
    expect(w.defaultTargetBranch).toBe("main"); // workspace has none -> global fallback
    expect(w.link_issues).toBe(true);
    expect(w.youtrack_base_url).toBeNull();
    expect(w.issues_provider).toBeNull(); // youtrack workspace: no github issues keys
    expect(w.link_on_pr).toBeNull();

    const p = withConfigFiles(
      {
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
      },
      {},
      () => vcsConfig("resolve", path.join(base, "personal", "some-app")),
    );
    expect(p.workspace_name).toBe("personal");
    expect(p.provider).toBe("github");
    expect(p.link_issues).toBeNull();
    expect(p.youtrack_base_url).toBeNull();
    expect(p.issues_provider).toBe("github");
    expect(p.link_on_pr).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("config.sh resolve: unmatched cwd falls back to global vcs.json; missing/malformed workspaces.json -> no workspace, no error", () => {
  const unmatched = path.join(os.tmpdir(), `wf-ws-unmatched-${Math.random()}`);
  mkdirSync(unmatched, { recursive: true });
  try {
    const noMatch = withConfigFiles({ "vcs.json": JSON.stringify(GLOBAL_VCS) }, {}, () =>
      vcsConfig("resolve", unmatched),
    );
    expect(noMatch.workspace_name).toBeNull();
    expect(noMatch.provider).toBe("github");
    expect(noMatch.defaultTargetBranch).toBe("main");
    expect(noMatch.link_issues).toBeNull();

    const malformed = withConfigFiles(
      { "vcs.json": JSON.stringify(GLOBAL_VCS), "workspaces.json": "{ nope !!" },
      {},
      () => vcsConfig("resolve", unmatched),
    );
    expect(malformed.workspace_name).toBeNull();
  } finally {
    rmSync(unmatched, { recursive: true, force: true });
  }
});

test("config.sh resolve: WORKFLOW_TOOLKIT_CONFIG dir is honored for vcs.json + workspaces.json (TS chain parity)", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-chain-"));
  writeFileSync(path.join(cfgDir, "vcs.json"), JSON.stringify(GLOBAL_VCS), "utf8");
  writeFileSync(
    path.join(cfgDir, "workspaces.json"),
    workspacesJson(`${base}/work/**`, "gitlab"),
    "utf8",
  );
  try {
    const out = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir }, () =>
      vcsConfig("resolve", path.join(base, "work", "repo")),
    );
    expect(out.workspace_name).toBe("work");
    expect(out.provider).toBe("gitlab");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("config.sh resolve: WORKFLOW_WORKSPACE_ROOT overrides the cwd", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  const elsewhere = path.join(os.tmpdir(), `wf-ws-elsewhere-${Math.random()}`);
  mkdirSync(elsewhere, { recursive: true });
  try {
    const r = withConfigFiles(
      {
        "vcs.json": JSON.stringify(GLOBAL_VCS),
        "workspaces.json": workspacesJson(`${base}/work/**`, "gitlab"),
      },
      { WORKFLOW_WORKSPACE_ROOT: path.join(base, "work", "repo") },
      () => vcsConfig("resolve", elsewhere),
    );
    expect(r.workspace_name).toBe("work");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("config.sh resolve: catchall ** matches a drive-letter WORKFLOW_WORKSPACE_ROOT (TS parity)", () => {
  const r = withConfigFiles(
    {
      "vcs.json": JSON.stringify(GLOBAL_VCS),
      "workspaces.json": workspacesJson("**", "gitlab"),
    },
    { WORKFLOW_WORKSPACE_ROOT: "D:/a/workflow-toolkit/workflow-toolkit" },
    () => vcsConfig("resolve", repoRoot),
  );
  expect(r.workspace_name).toBe("work");
});

test("config.sh load: merges the resolved workspace over global vcs.json", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-ws-dir-")));
  mkdirSync(path.join(base, "work", "repo"), { recursive: true });
  mkdirSync(path.join(base, "personal", "app"), { recursive: true });
  const files = {
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
  };
  try {
    const m = withConfigFiles(files, {}, () => vcsConfig("load", path.join(base, "work", "repo")));
    expect(m.ok).toBe(true);
    expect(m.provider).toBe("gitlab"); // workspace wins over global github
    expect(m.workspace_name).toBe("work");
    expect(m.link_issues).toBe(true);
    expect(m.issues_provider).toBeNull();
    expect(m.link_on_pr).toBeNull();
    expect(m.defaultTargetBranch).toBe("main"); // workspace has none -> global
    expect(m.tokenReady).toBe(false);

    const g = withConfigFiles(files, {}, () =>
      vcsConfig("load", path.join(base, "personal", "app")),
    );
    expect(g.provider).toBe("github");
    expect(g.workspace_name).toBe("personal");
    expect(g.issues_provider).toBe("github");
    expect(g.link_on_pr).toBe(true);
    expect(g.link_issues).toBeNull();
    expect(g.youtrack_base_url).toBeNull();

    const elsewhere = path.join(os.tmpdir(), `wf-ws-load-elsewhere-${Math.random()}`);
    mkdirSync(elsewhere, { recursive: true });
    const n = withConfigFiles(files, {}, () => vcsConfig("load", elsewhere));
    expect(n.provider).toBe("github");
    expect(n.workspace_name).toBeNull();
    expect(n.link_issues).toBeNull();
    rmSync(elsewhere, { recursive: true, force: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "pr-create.sh: missing gh/glab on PATH -> structured error with official install URL",
  () => {
    const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
    // Strip real gh/glab entries too (gh.exe) so the guard cannot find a real
    // CLI on the runner, not just the extensionless-name leftovers.
    const cleanPath = pathDirs.filter(
      (d) => d && !["gh", "gh.exe", "glab", "glab.exe"].some((n) => existsSync(path.join(d, n))),
    );

    for (const [provider, cli, url] of [
      ["github", "gh", "https://cli.github.com"],
      ["gitlab", "glab", "https://gitlab.com/gitlab-org/cli"],
    ] as const) {
      const err = withConfigFiles(
        {
          "vcs.json": JSON.stringify({ provider: "github" }),
          "workspaces.json": workspacesJson("**", provider),
          "github.token": "test-token-123",
          "gitlab.token": "test-token-123",
        },
        {
          PATH: `${os.tmpdir()}${path.delimiter}${cleanPath.join(path.delimiter)}`,
          WF_PR_CONFIRMED: "true",
          WF_PR_TITLE: "Test title",
        },
        () =>
          prCreate(
            { ...process.env, WF_PR_CONFIRMED: "true", WF_PR_TITLE: "Test title" },
            repoRoot,
          ),
      );
      expect(err.ok).toBe(false);
      expect(err.cli_missing).toBe(true);
      expect(err.install_url).toBe(url);
      expect(err.error).toContain(`workflow CLI missing: ${cli}`);
      expect(err.error).toContain(`required for ${provider}`);
      expect(err.error).toContain(url);
    }
    // Each iteration spawns git several times; Windows git cold starts exceed
    // the default 5s per-test budget.
  },
  { timeout: 60_000 },
);

test("pr-ready-context.sh: VCS Config section reports workspace + provider", () => {
  const r = withConfigFiles(
    {
      "vcs.json": JSON.stringify(GLOBAL_VCS),
      "workspaces.json": workspacesJson("**", "gitlab"),
    },
    {},
    () => prReadyContext(repoRoot, "HEAD~1..HEAD"),
  );
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.stdout).toContain("workspace: work");
  expect(r.stdout).toContain("provider: gitlab");
  expect(r.stdout).not.toContain("vcs: not configured");
  // B4: concise shell shape — workspace:/provider: only, no raw summary JSON
  // dumped into the VCS Config section.
  const vcsSection = parseSections(r.stdout)["VCS Config"] ?? "";
  expect(vcsSection).not.toContain('"defaultTargetBranch"');
  expect(vcsSection).not.toContain('"ok":');
});

test("pr-ready-context.sh: malformed vcs.json reports unreadable instead of silent defaults (RL-01)", () => {
  const r = withConfigFiles({ "vcs.json": "{ broken !!" }, {}, () =>
    prReadyContext(repoRoot, "HEAD~1..HEAD"),
  );
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.stdout).toContain("vcs: unreadable (malformed)");
  expect(r.stdout).toContain("vcs.json");
  expect(r.stdout).not.toContain("workspace: none");
  expect(r.stdout).not.toContain("provider: gitlab");
});

test("pr-ready-context.sh uses the workspace target branch", () => {
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

  try {
    const result = withConfigFiles(
      {
        "vcs.json": JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
        "workspaces.json": workspacesJson(`${repo}/**`, "github", {
          vcs: { defaultTargetBranch: "main" },
        }),
      },
      {},
      () => prReadyContext(repo),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("base_ref: main");
    expect(result.stdout).toContain("range: main..HEAD");
    expect(result.stdout).toContain("feature change");
    expect(result.stdout).not.toContain("main base");
  } finally {
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
  return prBuildBody({ ...env, ...extra }, cwd ?? repoRoot);
};

test("pr-create.sh --build-body: branch-derived issue id appends Related to line", () => {
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

test("pr-create.sh --build-body: date-like branch prefixes never close an unrelated issue (RL-03/CA-25)", () => {
  // Task 15 advisory: feature/2024-01-15/x derived a year and closed #2024.
  // Year-first date segments must not be interpreted as issue ids.
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-01-15/fix" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "2024-01-15/fix" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-01/foo" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-11-30" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "2024-1-2" })).toBe("");
  // B2: day-first date segments (15-01-2024) must not derive a day-of-month id.
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024/fix" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "15-01-2024/fix" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024" })).toBe("");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/1-2-2024/foo" })).toBe("");
  // deliberate numeric issue branches still link
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
  expect(buildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
  // youtrack letter derivation is unaffected by date segments
  expect(
    buildBody({
      LINK_ISSUES: "true",
      BRANCH: "feature/2024-01-15/IRP-123",
      YT_BASE_URL: "https://yt.example.com",
    }),
  ).toBe("Related to: https://yt.example.com/issue/IRP-123");
});

test("pr-create.sh --build-body: explicit WORKFLOW_YT_ISSUE wins over branch-derived id", () => {
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
  // stub gh records its args and returns a fake PR URL; the rest of PATH mirrors the CLI-guard test
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-bin-"));
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-gh-repo-")));
  const logFile = path.join(stubBin, "args.txt");
  stubCli(stubBin, "gh", logFile, "https://github.com/o/r/pull/1");
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  // Strip real gh/glab entries too (gh.exe) so the guard cannot find a real
  // CLI on the runner, not just the extensionless-name leftovers.
  const cleanPath = pathDirs.filter(
    (d) => d && !["gh", "gh.exe", "glab", "glab.exe"].some((n) => existsSync(path.join(d, n))),
  );

  try {
    for (const [cmd, args] of [
      ["git", ["init", "-q"]],
      ["git", ["remote", "add", "origin", "git@github.com:o/r.git"]],
    ] as const) {
      expect(spawnSync(cmd, args, { cwd: repoDir, encoding: "utf8" }).status).toBe(0);
    }
    const r = withConfigFiles(
      {
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
      },
      {
        PATH: `${stubBin}${path.delimiter}${cleanPath.join(path.delimiter)}`,
        WF_PR_CONFIRMED: "true",
        WF_PR_TITLE: "Test title",
        WORKFLOW_GH_ISSUE: "42",
      },
      () =>
        prCreate(
          {
            ...process.env,
            WF_PR_CONFIRMED: "true",
            WF_PR_TITLE: "Test title",
            WORKFLOW_GH_ISSUE: "42",
          },
          repoDir,
        ),
    );
    expect(r.ok, `create failed: ${JSON.stringify(r)}`).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("Closes #42");
  } finally {
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("pr-create.sh create: target branch flows from config for every preset (RL-03)", () => {
  const CASES = [
    { preset: "gitflow", provider: "gitlab", target: "develop" },
    { preset: "github-flow", provider: "github", target: "main" },
    { preset: "trunk-based", provider: "github", target: "main" },
    { preset: "custom", provider: "gitlab", target: "trunk" },
  ] as const;
  for (const c of CASES) {
    const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-pr-target-"));
    const stub = c.provider === "gitlab" ? "glab" : "gh";
    const logFile = path.join(stubBin, `${stub}-args.txt`);
    stubCli(stubBin, stub, logFile, "https://example.com/ok");
    const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
    const cleanPath = pathDirs.filter(
      (d) => d && !existsSync(path.join(d, "gh")) && !existsSync(path.join(d, "glab")),
    );
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-pr-target-repo-")));
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q", "-b", "develop"]);
    git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "base"]);
    try {
      const r = withConfigFiles(
        {
          "vcs.json": JSON.stringify({ provider: c.provider, defaultTargetBranch: c.target }),
          "workspaces.json": workspacesJson(`${repo}/**`, c.provider, {
            vcs: { defaultTargetBranch: c.target },
          }),
          [`${c.provider}.token`]: "test-token-123",
        },
        {
          PATH: `${stubBin}${path.delimiter}${cleanPath.join(path.delimiter)}`,
          WF_PR_CONFIRMED: "true",
          WF_PR_TITLE: "T",
        },
        () => prCreate({ ...process.env, WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, repo),
      );
      expect(r.ok, `${c.preset}: ${JSON.stringify(r)}`).toBe(true);
      expect(r.targetBranch).toBe(c.target);
      const logged = readFileSync(logFile, "utf8");
      if (c.provider === "gitlab") expect(logged).toContain(`-b ${c.target}`);
      else expect(logged).toContain(`--base ${c.target}`);
    } finally {
      rmSync(stubBin, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("RL-08: writeWorkspaces rejects unsupported glob grammar at write time", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ws-write-"));
  try {
    withEnv({ WORKFLOW_TOOLKIT_CONFIG: dir }, () => {
      const ok = writeWorkspaces([
        { name: "work", glob: "/home/*/work/**", vcs: { provider: "gitlab" } },
      ]);
      expect(ok.ok).toBe(true);
      expect(ok.path).toBe(path.join(dir, "workspaces.json"));
      expect(existsSync(ok.path)).toBe(true);
      for (const bad of [
        "/home/*/[abc]/**",
        "/home/*/x?/**",
        "/home/*/{a,b}/**",
        "**/[ab]/**",
        "!**",
        "/home/*/@(a|b)/**",
        "/home/*/+(a|b)/**",
      ]) {
        const r = writeWorkspaces([{ name: "work", glob: bad, vcs: { provider: "gitlab" } }]);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("unsupported");
      }
      expect(validateWorkspaceGlob("**").ok).toBe(true);
      expect(validateWorkspaceGlob("/x/?/**").ok).toBe(false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR context base_ref and prCreate target agree for the same workspace (RL-03)", () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wf-pr-ctx-create-")));
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Workflow Test"]);
  git(["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "base"]);
  git(["branch", "develop"]);
  git(["checkout", "-q", "-b", "feature/ctx-create"]);
  try {
    const ctx = withConfigFiles(
      {
        "vcs.json": JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
        "workspaces.json": workspacesJson(`${repo}/**`, "gitlab", {
          vcs: { defaultTargetBranch: "main" },
        }),
      },
      {},
      () => resolvePrBranchContext(repo),
    );
    expect(ctx.ok).toBe(true);
    if (ctx.ok) expect([`origin/main`, `main`]).toContain(ctx.value.baseRef);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
