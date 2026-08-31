import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";
import { prBuildBody, prCreate } from "../../packages/workit-core/src/core/pr-create";
import { stubCli, stubPath as stubPathWith } from "../shared/helpers/stub-cli";

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
let bareRemote: string;

beforeEach(() => {
  cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-cfg-"));
  root = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-repo-"));
  stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-bin-"));
  logFile = path.join(stubBin, "gh-args.txt");
  bareRemote = mkdtempSync(path.join(os.tmpdir(), "wf-pr-create-remote-"));
  git(bareRemote, ["init", "-q", "--bare"]);
  stubCli(stubBin, "gh", logFile, "https://github.com/o/r/pull/1");
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(stubBin, { recursive: true, force: true });
  rmSync(bareRemote, { recursive: true, force: true });
});

// Stub gh/glab are prepended to PATH so they win; the rest of PATH (including
// git) stays intact for the wrapper's branch lookups.
const stubPath = (): string => stubPathWith(stubBin);

const setupRepo = () => {
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
};

// push-before-create (Task 2) needs a real pushable origin: a bare remote that
// already carries develop, so `git push -u origin <feature>` succeeds.
const setupRepoWithOrigin = () => {
  setupRepo();
  git(root, ["remote", "add", "origin", bareRemote]);
  git(root, ["push", "-q", "-u", "origin", "develop"]);
};

const writeConfig = (
  branchPolicy: Record<string, unknown>,
  defaultTargetBranch: string,
  pr?: Record<string, unknown>,
  provider: "github" | "gitlab" = "github",
) => {
  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ branchPolicy }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "vcs.json"),
    JSON.stringify({ provider, defaultTargetBranch, ...(pr ? { pr } : {}) }),
    "utf8",
  );
  writeFileSync(
    path.join(cfgDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "t",
          glob: `${root}/**`,
          vcs: { provider },
          issues: { provider, link_on_pr: true },
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(path.join(cfgDir, `${provider}.token`), "test-token\n", "utf8");
};

const customPolicy = {
  preset: "custom",
  allowed: ["main", "trunk", "feature/*"],
  protected: ["develop"],
};

test(
  "B1: caller-supplied WF_PR_TARGET is validated against the branch policy",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "main" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(readFileSync(logFile, "utf8")).toContain("--base main");
  },
  { timeout: 60_000 },
);

test(
  "B1: invalid WF_PR_TARGET override is rejected (protected + disallowed)",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const run = (target: string) =>
      withEnv(
        {
          WORKFLOW_TOOLKIT_CONFIG: cfgDir,
          PATH: stubPath(),
        },
        () => {
          writeConfig(customPolicy, "trunk");
          return prCreate(
            { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: target },
            root,
          );
        },
      );
    const protectedTarget = run("develop");
    expect(protectedTarget.ok).not.toBe(true);
    expect(protectedTarget.error).toContain("protected branch");
    const disallowed = run("random/x");
    expect(disallowed.ok).not.toBe(true);
    expect(disallowed.error).toContain("not allowed by the branch policy");
  },
  { timeout: 60_000 },
);

test(
  "B1: no override still flows the configured default target (unvalidated)",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/b1"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("trunk");
  },
  { timeout: 60_000 },
);

// CA-06: a caller-supplied WF_PR_TARGET equal to the resolved workspace default
// (main under github-flow, develop under gitflow) is authoritative — the same
// value flows unvalidated from config, so an explicit equal value must not be
// rejected as a protected override.

const setupMainRepo = () => {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", bareRemote]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
};

test(
  "CA-06: default-equal WF_PR_TARGET is accepted under github-flow (main)",
  () => {
    setupMainRepo();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig({ preset: "github-flow" }, "main");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "main" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("main");
    expect(readFileSync(logFile, "utf8")).toContain("--base main");
  },
  { timeout: 60_000 },
);

test(
  "CA-06: default-equal WF_PR_TARGET is accepted under gitflow (develop)",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig({ preset: "gitflow" }, "develop");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: "develop" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.targetBranch).toBe("develop");
    expect(readFileSync(logFile, "utf8")).toContain("--base develop");
  },
  { timeout: 60_000 },
);

test(
  "CA-06: genuine overrides are still rejected when they differ from the default",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const run = (target: string) =>
      withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
        writeConfig({ preset: "gitflow" }, "develop");
        return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_TARGET: target }, root);
      });
    const protectedTarget = run("main");
    expect(protectedTarget.ok).not.toBe(true);
    expect(protectedTarget.error).toContain("protected branch");
    const disallowed = run("random/x");
    expect(disallowed.ok).not.toBe(true);
    expect(disallowed.error).toContain("not allowed by the branch policy");
  },
  { timeout: 60_000 },
);

const withWrapperConfig = <T>(fn: () => Promise<T>): Promise<T> => {
  const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const previousPath = process.env.PATH;
  process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
  process.env.PATH = stubPath();
  return fn().finally(() => {
    if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
};

test(
  "CA-06: OpenCode wrapper accepts a default-equal target_branch",
  async () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const raw = await withWrapperConfig(() => {
      writeConfig({ preset: "gitflow" }, "develop");
      return createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T", target_branch: "develop" },
        { directory: root, worktree: root } as never,
      );
    });
    const result = JSON.parse(raw as string);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.targetBranch).toBe("develop");
  },
  { timeout: 60_000 },
);

test(
  "CA-06: OpenCode wrapper still rejects a genuine protected target_branch",
  async () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    const raw = await withWrapperConfig(() => {
      writeConfig({ preset: "gitflow" }, "develop");
      return createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T", target_branch: "main" },
        { directory: root, worktree: root } as never,
      );
    });
    const result = JSON.parse(raw as string);
    expect(result.ok).not.toBe(true);
    expect(JSON.stringify(result)).toContain("protected branch");
  },
  { timeout: 60_000 },
);

// CA-06 parity through the CLI port: the port reads WF_PR_TARGET and delegates
// to prCreate(process.env, process.cwd()), so accept/reject outcomes must match
// the core exactly.

const cliPortPath = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "workit-core",
  "src",
  "core",
  "ports",
  "pr-create.ts",
);

const runCliPort = (target: string) =>
  withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
    const spawned = spawnSync(process.execPath, [cliPortPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKFLOW_TOOLKIT_CONFIG: cfgDir,
        PATH: stubPath(),
        WF_PR_CONFIRMED: "true",
        WF_PR_TITLE: "T",
        WF_PR_TARGET: target,
      },
    });
    return { status: spawned.status, stdout: (spawned.stdout ?? "").trim() };
  });

test(
  "CA-06: CLI port accepts a default-equal target and rejects a genuine override",
  () => {
    setupRepoWithOrigin();
    git(root, ["checkout", "-q", "-b", "feature/ca06"]);
    writeConfig({ preset: "gitflow" }, "develop");
    const accepted = runCliPort("develop");
    expect(accepted.status).toBe(0);
    const acceptedResult = JSON.parse(accepted.stdout);
    expect(acceptedResult.ok, accepted.stdout).toBe(true);
    expect(acceptedResult.targetBranch).toBe("develop");
    const rejected = runCliPort("main");
    expect(rejected.status).toBe(1);
    const rejectedResult = JSON.parse(rejected.stdout);
    expect(rejectedResult.error).toContain("protected branch");
  },
  { timeout: 60_000 },
);

test(
  "B2: day-first date segments never derive a numeric issue id",
  () => {
    // the year-first cases are covered in workspaces-scripts.test.ts; these are
    // the day-first cases the advisory called out (15-01-2024 -> not Closes #15).
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024/fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "15-01-2024/fix" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/15-01-2024" })).toBe("");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/1-2-2024/foo" })).toBe("");
    // deliberate numeric issue branches still link
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/42-title" })).toBe("Closes #42");
    expect(prBuildBody({ GH_LINK_ON_PR: "true", BRANCH: "feature/2024-fix" })).toBe("Closes #2024");
  },
  { timeout: 60_000 },
);

test(
  "AR-08: complete dates anywhere in a segment never close an issue",
  () => {
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
  },
  { timeout: 60_000 },
);

test(
  "CA-04: merge integration finishes the feature into the target without a PR",
  () => {
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
      expect(p.merged).toBe(true);
      expect(p.pushed).toBe(true);
      const log = git(root, ["log", "--oneline", "-1", "develop"]).stdout;
      expect(log).toContain("T");
      const remoteLog = git(root, ["log", "--oneline", "-1", "origin/develop"]).stdout;
      expect(remoteLog).toContain("T");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "B6: env-driven WORKFLOW_GH_ISSUE reaches prCreate through the OpenCode wrapper",
  async () => {
    setupRepoWithOrigin();
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
      const raw = await createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T" },
        {
          directory: root,
          worktree: root,
        } as never,
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
  },
  { timeout: 60_000 },
);

// Task 2 — GitHub push-before-create honoring pr.pushBranch.

const branchOn = () => {
  git(root, ["checkout", "-q", "-b", "feature/t2"]);
  writeFileSync(path.join(root, "feature.txt"), "work\n");
  git(root, ["add", "feature.txt"]);
  git(root, ["commit", "-q", "-m", "feature work"]);
};

test(
  "T2: github pushBranch enabled pushes the branch before gh pr create",
  () => {
    setupRepoWithOrigin();
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    // the branch reached origin before gh ran (git push -u created it)
    expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).toBe(0);
    expect(readFileSync(logFile, "utf8")).toContain("pr create");
  },
  { timeout: 60_000 },
);

test(
  "T2: github pushBranch false skips the push and still creates via gh",
  () => {
    setupRepoWithOrigin();
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: false });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    // no push: the branch must not exist on origin
    expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).not.toBe(0);
    expect(readFileSync(logFile, "utf8")).toContain("pr create");
  },
  { timeout: 60_000 },
);

test(
  "T2: github push failure returns a structured push failed result without gh",
  () => {
    setupRepo();
    git(root, ["remote", "add", "origin", bareRemote]);
    git(root, ["push", "-q", "-u", "origin", "develop"]);
    // reject every subsequent push deterministically
    writeFileSync(path.join(bareRemote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok).not.toBe(true);
    expect(result.error).toBe("push failed");
    expect(result.stderr).toBeTruthy();
    expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).not.toBe(0);
    expect(existsSync(logFile)).toBe(false); // gh never ran
  },
  { timeout: 60_000 },
);

test(
  "T2: github pushBranch with an unborn HEAD (empty branch) fails closed without gh",
  () => {
    // a repo with no commits has no current branch: `git push -u origin ""`
    // would fail with git's raw refspec error, so the guard must return a
    // readable push-failed result and gh must never run.
    git(root, ["init", "-q", "-b", "develop"]);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    git(root, ["remote", "add", "origin", bareRemote]);
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok).not.toBe(true);
    expect(result.error).toBe("push failed");
    expect(result.mode).toBe("push");
    expect(result.stderr).toContain("empty current branch");
    expect(existsSync(logFile)).toBe(false); // gh never ran
  },
  { timeout: 60_000 },
);

test(
  "T2: github push-before-create flows through the OpenCode wrapper",
  async () => {
    setupRepoWithOrigin();
    branchOn();
    const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const previousPath = process.env.PATH;
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
    process.env.PATH = stubPath();
    try {
      writeConfig(customPolicy, "trunk", { pushBranch: true });
      const raw = await createRepoTools().workit_pr_create.execute(
        { confirmed: true, title: "T" },
        {
          directory: root,
          worktree: root,
        } as never,
      );
      const result = JSON.parse(raw as string);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).toBe(0);
      expect(readFileSync(logFile, "utf8")).toContain("pr create");
    } finally {
      if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
  { timeout: 60_000 },
);

test(
  "T2: gitlab parity — single glab invocation carries --push, no git push by prCreate",
  () => {
    const glabLog = path.join(stubBin, "glab-args.txt");
    stubCli(stubBin, "glab", glabLog, "https://gitlab.com/o/r/-/merge_requests/1");
    setupRepoWithOrigin();
    branchOn();
    const result = withEnv({ WORKFLOW_TOOLKIT_CONFIG: cfgDir, PATH: stubPath() }, () => {
      writeConfig(customPolicy, "trunk", { pushBranch: true }, "gitlab");
      return prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    });
    expect(result.ok, `create failed: ${JSON.stringify(result)}`).toBe(true);
    const lines = readFileSync(glabLog, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--push");
    // glab owns the push (stubbed here): prCreate itself never ran git push
    expect(git(root, ["rev-parse", "--verify", "origin/feature/t2"]).status).not.toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "T2: CLI port delegates to core prCreate without interception",
  () => {
    const port = readFileSync(
      path.resolve(
        import.meta.dir,
        "..",
        "..",
        "packages",
        "workit-core",
        "src",
        "core",
        "ports",
        "pr-create.ts",
      ),
      "utf8",
    );
    expect(port).toContain('import { prBuildBody, prCreate } from "../pr-create"');
    expect(port).toContain("prCreate(process.env, process.cwd())");
  },
  { timeout: 60_000 },
);
