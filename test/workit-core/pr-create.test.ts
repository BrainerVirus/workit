import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";
import { prBuildBody, prCreate } from "../../packages/workit-core/src/core/pr-create";

// B1/B6 advisory coverage: WF_PR_TARGET override validation against the branch
// policy, and env-driven issue linking through the OpenCode tool wrapper.

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

const ENV_KEYS = [
  "WORKFLOW_TOOLKIT_CONFIG",
  "WORKFLOW_TOOLKIT_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "WORKFLOW_VCS_CONFIG",
  "WORKFLOW_WORKSPACE_ROOT",
  "WORKFLOW_YT_ISSUE",
  "WORKFLOW_GH_ISSUE",
  "WORKFLOW_GH_ISSUE_RELATION",
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

let cfgDir: string;
let root: string;
let stubBin: string;
let logFile: string;

beforeEach(() => {
  cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-cfg-"));
  root = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-repo-"));
  stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-bin-"));
  logFile = path.join(stubBin, "gh-args.txt");
  writeFileSync(
    path.join(stubBin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\necho "https://github.com/o/r/pull/1"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(stubBin, { recursive: true, force: true });
});

// Stub gh/glab are prepended to PATH so they win; the rest of PATH (including
// git) stays intact for the wrapper's branch lookups.
const stubPath = (): string => `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`;

const setupRepo = () => {
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
};

const writeConfig = (branchPolicy: Record<string, unknown>, defaultTargetBranch: string) => {
  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ branchPolicy }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "vcs.json"),
    JSON.stringify({ provider: "github", defaultTargetBranch }),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "t",
          glob: `${root}/**`,
          vcs: { provider: "github" },
          issues: { provider: "github", link_on_pr: true },
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(path.join(cfgDir, "github.token"), "test-token\n", "utf8");
};

const customPolicy = {
  preset: "custom",
  allowed: ["main", "trunk", "feature/*"],
  protected: ["develop"],
};

test("B1: caller-supplied WF_PR_TARGET is validated against the branch policy", () => {
  setupRepo();
  git(root, ["checkout", "-q", "-b", "feature/b1"]);
  const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
    writeConfig(customPolicy, "trunk");
    return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "main" }, root);
  });
  expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
  expect(result.targetBranch).toBe("main");
  expect(readFileSync(logFile, "utf8")).toContain("--base main");
});

test("B1: invalid WF_PR_TARGET override is rejected (protected + disallowed)", () => {
  setupRepo();
  git(root, ["checkout", "-q", "-b", "feature/b1"]);
  const run = (target: string) =>
    withEnv(
      {
        WORKFLOW_TOOLKIT_CONFIG: cfgDir,
        PATH: stubPath(),
      },
      () => {
        writeConfig(customPolicy, "trunk");
        return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: target }, root);
      },
    );
  const protectedTarget = run("develop");
  expect(protectedTarget.ok).not.toBe(true);
  expect(protectedTarget.error).toContain("protected branch");
  const disallowed = run("random/x");
  expect(disallowed.ok).not.toBe(true);
  expect(disallowed.error).toContain("not allowed by the branch policy");
});

test("B1: no override still flows the configured default target (unvalidated)", () => {
  setupRepo();
  git(root, ["checkout", "-q", "-b", "feature/b1"]);
  const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
    writeConfig(customPolicy, "trunk");
    return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
  });
  expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
  expect(result.targetBranch).toBe("trunk");
});

test("B2: day-first date segments never derive a numeric issue id", () => {
  // the year-first cases are covered in workspaces-scripts.test.ts; these are
  // the day-first cases the advisory called out (15-01-2024 -> not Closes #15).
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024/fix" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "15-01-2024/fix" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/1-2-2024/foo" })).toBe("");
  // deliberate numeric issue branches still link
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
});

test("AR-08: complete dates anywhere in a segment never close an issue", () => {
  // Task 22 advisory: date rejection was year-first only; an embedded year-first
  // or day-first date (release-2024-01-15, v2-2024-01-15-fix) still derived a
  // year/day id. Complete dates must be rejected anywhere in a segment.
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release-2024-01-15" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "v2-2024-01-15-fix" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release-2024-01-15/fix" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "fix-2024-01-15" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "fix-15-01-2024" })).toBe("");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/fix-15-01-2024" })).toBe("");
  // deliberate numeric issue branches still link
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
  expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "release/2024-fix" })).toBe("Closes #2024");
});

test("CA-04: merge integration finishes the feature into the target without a PR", () => {
  // bare origin remote, like branch-policy.test.ts's repoWithDevelop
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-merge-remote-"));
  try {
    git(remote, ["init", "-q", "--bare"]);
    setupRepo();
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "-u", "origin", "develop"]);
    git(root, ["branch", "main"]);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-q", "-b", "feature/merge-mode"]);
    // the brief's literal test omitted a feature commit; without one develop is
    // up to date and --no-ff merges nothing, so the "T" commit never appears.
    writeFileSync(path.join(root, "feature.md"), "work\n");
    git(root, ["add", "feature.md"]);
    git(root, ["commit", "-q", "-m", "feature work"]);
    git(root, ["push", "-q", "-u", "origin", "feature/merge-mode"]);
    writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "gitflow" } }, null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(cfgDir, "vcs.json"),
      JSON.stringify({ provider: "github", defaultTargetBranch: "develop" }),
      "utf8",
    );
    writeFileSync(
      path.join(cfgDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "t",
            glob: `${root}/**`,
            branchPolicy: { preset: "gitflow", integration: "merge" },
          },
        ],
      }),
      "utf8",
    );
    // no token written on purpose: merge mode is local git merge + push and must
    // work tokenless (SSH-push users have no glab/gh API token).
    const p = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () =>
      prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "" }, root),
    );
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(p.mode).toBe("merge");
    expect(p.targetBranch).toBe("develop");
    const log = git(root, ["log", "--oneline", "-1", "develop"]).stdout;
    expect(log).toContain("T");
  } finally {
    rmSync(remote, { recursive: true, force: true });
  }
});

test("B6: env-driven WORKFLOW_GH_ISSUE reaches prCreate through the OpenCode wrapper", async () => {
  setupRepo();
  git(root, ["checkout", "-q", "-b", "feature/b6"]);
  const previous = process.env.WORKFLOW_GH_ISSUE;
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousPath = process.env.PATH;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
  process.env.WORKFLOW_GH_ISSUE = "42";
  process.env.PATH = stubPath();
  try {
    writeConfig(
      { preset: "gitflow", allowed: ["feature/*", "bugfix/*"], protected: ["main", "develop"] },
      "develop",
    );
    const raw = await createRepoTools().workflow_pr_create.execute(
      { confirmed: true, title: "T" },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // only the 5 explicit WF_PR_* keys are passed by the tool; the env-driven
    // issue id must still flow through the wrapper's process.env merge.
    expect(readFileSync(logFile, "utf8")).toContain("Closes #42");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_GH_ISSUE;
    else process.env.WORKFLOW_GH_ISSUE = previous;
    if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
