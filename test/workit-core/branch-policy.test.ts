import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../../packages/workit-core/src/tools/repo";
import { createSddTools } from "../../packages/workit-core/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import { docsBranch, resolveBranch } from "../../packages/workit-core/src/core/branch";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
  writeFileSync(
    path.join(isolatedConfig, "config.json"),
    JSON.stringify(
      {
        locale: "en",
        localeOptions: ["en"],
        timezone: "UTC",
        branchPolicy: {
          preset: "gitflow",
          allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
          protected: ["main", "develop", "master", "prod", "production"],
        },
      },
      null,
      2,
    ),
  );
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const repoWithDevelop = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "wf-branch-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["init", "-q", "-b", "develop"]);
  git(root, ["config", "user.name", "Workflow Test"]);
  git(root, ["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "develop"]);
  git(root, ["branch", "main"]);
  git(root, ["checkout", "-q", "main"]);
  return { root, remote };
};

test("workflow_docs_branch keeps current feature branch", async () => {
  const { root, remote } = repoWithDevelop();
  git(root, ["checkout", "-q", "-b", "feature/current"]);
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_branch.execute({}, {
      directory: root,
      worktree: root,
      sessionID: "t",
    } as never);
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("keep");
    expect(result.data.branch).toBe("feature/current");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("workflow_docs_branch proposes create_from_develop on main", async () => {
  const { root, remote } = repoWithDevelop();
  mkdirSync(path.join(root, "docs", "2026-08-04-gates"), { recursive: true });
  const plan = "docs/2026-08-04-gates/plan.md";
  writeFileSync(path.join(root, plan), "# Plan\n");
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_branch.execute(
      { plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("create_from_develop");
    expect(result.data.branch).toBe("feature/2026-08-04-gates");
    expect(result.data.current_branch).toBe("main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup creates feature branch from develop when starting on main", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    const raw = await createRepoTools().workflow_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "feature/x",
        stash: "no",
      },
      { directory: root, worktree: root } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(git(root, ["branch", "--show-current"]).stdout.trim()).toBe("feature/x");
    const mergeBase = git(root, ["merge-base", "feature/x", "develop"]).stdout.trim();
    const developHead = git(root, ["rev-parse", "develop"]).stdout.trim();
    expect(mergeBase).toBe(developHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("workspace target branch drives docs branch and branch setup", async () => {
  const { root, remote } = repoWithDevelop();
  const workspaces = path.join(isolatedConfig, "workit", "workspaces.json");
  try {
    writeFileSync(path.join(root, "main.txt"), "main only\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "-q", "-m", "main only"]);
    git(root, ["push", "-q", "-u", "origin", "main"]);
    mkdirSync(path.dirname(workspaces), { recursive: true });
    writeFileSync(
      workspaces,
      JSON.stringify({
        workspaces: [
          {
            name: "github",
            glob: `${root}/**`,
            vcs: { provider: "github", defaultTargetBranch: "main" },
          },
        ],
      }),
    );
    mkdirSync(path.join(root, "docs", "github-flow"), { recursive: true });
    writeFileSync(path.join(root, "docs/github-flow/plan.md"), "# Plan\n");
    git(root, ["add", "docs/github-flow/plan.md"]);
    git(root, ["commit", "-q", "-m", "plan"]);

    const resolved = docsBranch({ plan_path: "docs/github-flow/plan.md", workspace_root: root });
    expect(resolved.action).toBe("create_from_base");
    expect(resolved.base).toBe("main");

    const raw = await createRepoTools().workflow_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "feature/github-flow",
        stash: "no",
      },
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(git(root, ["rev-parse", "feature/github-flow"]).stdout.trim()).toBe(
      git(root, ["rev-parse", "main"]).stdout.trim(),
    );
  } finally {
    rmSync(workspaces, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("docs branch recognizes a custom configured base", () => {
  const { root, remote } = repoWithDevelop();
  const workspaces = path.join(isolatedConfig, "workit", "workspaces.json");
  const config = path.join(isolatedConfig, "workit", "config.json");
  try {
    git(root, ["checkout", "-q", "-b", "trunk"]);
    git(root, ["push", "-q", "-u", "origin", "trunk"]);
    mkdirSync(path.dirname(workspaces), { recursive: true });
    writeFileSync(
      workspaces,
      JSON.stringify({
        workspaces: [
          {
            name: "custom",
            glob: `${root}/**`,
            vcs: { provider: "github", defaultTargetBranch: "trunk" },
          },
        ],
      }),
    );
    writeFileSync(
      config,
      JSON.stringify({
        branchPolicy: { preset: "custom", allowed: ["trunk", "feature/*"], protected: ["main"] },
      }),
    );
    mkdirSync(path.join(root, "docs", "custom-base"), { recursive: true });
    writeFileSync(path.join(root, "docs/custom-base/plan.md"), "# Plan\n");

    const resolved = docsBranch({ plan_path: "docs/custom-base/plan.md", workspace_root: root });
    expect(resolved.action).toBe("create_from_base");
    expect(resolved.base).toBe("trunk");
    expect(resolved.branch).toBe("feature/custom-base");
  } finally {
    rmSync(workspaces, { force: true });
    rmSync(config, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("branch setup errors when origin develop is missing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-branch-no-develop-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Workflow Test"]);
    git(root, ["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "README.md"), "base\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "base"]);
    const raw = await createRepoTools().workflow_branch_setup.execute(
      {
        confirmed: true,
        target_branch: "feature/x",
        stash: "no",
      },
      { directory: root, worktree: root } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch resolution honors use-current and bugfix slug/kind derivation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-derive-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["branch", "feature/current"]);
    run(["branch", "feature/base"]);
    run(["checkout", "-q", "feature/base"]);

    mkdirSync(path.join(dir, "docs", "uc"), { recursive: true });
    mkdirSync(path.join(dir, "docs", "x"), { recursive: true });
    mkdirSync(path.join(dir, "docs", "fix-x"), { recursive: true });
    mkdirSync(path.join(dir, "docs", "g"), { recursive: true });
    mkdirSync(path.join(dir, "docs", "feat"), { recursive: true });
    writeFileSync(path.join(dir, "docs/uc/spec.md"), "# UC\n\n**Branch:** use-current\n");
    writeFileSync(
      path.join(dir, "docs/uc/plan.md"),
      "# UC\n\n**Spec:** `docs/uc/spec.md`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const useCurrent = resolveBranch({
      spec_path: "docs/uc/spec.md",
      plan_path: "docs/uc/plan.md",
      workspace_root: dir,
    });
    expect("error" in useCurrent ? useCurrent.error : useCurrent.source).toBe("use-current");
    expect("error" in useCurrent ? useCurrent.error : useCurrent.branch).toBe("feature/base");

    run(["branch", "main"]);
    run(["checkout", "-q", "main"]);
    writeFileSync(
      path.join(dir, "docs/fix-x/plan.md"),
      "# Fix x\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const fixSlug = resolveBranch({
      spec_path: "missing.md",
      plan_path: "docs/fix-x/plan.md",
      workspace_root: dir,
    });
    expect("error" in fixSlug ? fixSlug.error : fixSlug.branch).toBe("bugfix/fix-x");

    writeFileSync(
      path.join(dir, "docs/g/plan.md"),
      "# G\n\n**Goal:** bug fix without adding features\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const goal = resolveBranch({
      spec_path: "missing.md",
      plan_path: "docs/g/plan.md",
      workspace_root: dir,
    });
    expect("error" in goal ? goal.error : goal.branch).toBe("bugfix/g");

    writeFileSync(
      path.join(dir, "docs/feat/plan.md"),
      "# F\n\n**Goal:** Add cool feature\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const feat = resolveBranch({
      spec_path: "missing.md",
      plan_path: "docs/feat/plan.md",
      workspace_root: dir,
    });
    expect("error" in feat ? feat.error : feat.branch).toBe("feature/feat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch setup guards protected targets, missing targets, and dirty stash flow", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-guards-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["branch", "main"]);
    run(["checkout", "-q", "main"]);

    const tools = createRepoTools();
    const ctx = { directory: dir, worktree: dir } as never;
    const noTarget = JSON.parse(
      (await tools.workflow_branch_setup.execute({ confirmed: true }, ctx)) as string,
    );
    expect(noTarget.error).toContain("target branch required");
    const protected_ = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        { confirmed: true, target_branch: "main" },
        ctx,
      )) as string,
    );
    expect(protected_.error).toContain("protected branch");
    const badKind = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        { confirmed: true, target_branch: "random/x" },
        ctx,
      )) as string,
    );
    expect(badKind.error).toContain("not allowed by the branch policy");

    run(["checkout", "-q", "-b", "feature/dirty"]);
    writeFileSync(path.join(dir, "dirty.txt"), "uncommitted");
    const dirty = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        { confirmed: true, target_branch: "feature/next", stash: "no" },
        ctx,
      )) as string,
    );
    expect(dirty.error).toContain("dirty working tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch setup reapply_stash requires a recorded stash ref", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-reapply-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);

    const tools = createRepoTools();
    const ctx = { directory: dir, worktree: dir } as never;
    const noRef = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        { confirmed: true, action: "reapply_stash" },
        ctx,
      )) as string,
    );
    expect(noRef.error).toContain("no stash_ref");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch setup stash + reapply round trip restores changes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-stash-roundtrip-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["checkout", "-q", "-b", "feature/dirty"]);
    run(["checkout", "-q", "-b", "feature/next"]);
    run(["checkout", "-q", "feature/dirty"]);
    writeFileSync(path.join(dir, "dirty.txt"), "wip");

    const tools = createRepoTools();
    const ctx = { directory: dir, worktree: dir } as never;
    const setup = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        {
          confirmed: true,
          target_branch: "feature/next",
          stash: "yes",
        },
        ctx,
      )) as string,
    );
    expect(setup.ok).toBe(true);
    expect(existsSync(path.join(dir, "dirty.txt"))).toBe(false);

    const reapply = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        {
          confirmed: true,
          action: "reapply_stash",
        },
        ctx,
      )) as string,
    );
    expect(reapply.ok).toBe(true);
    expect(existsSync(path.join(dir, "dirty.txt"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch setup fails from a feature branch when origin develop is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-no-origin-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "develop"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["checkout", "-q", "-b", "feature/start"]);

    const tools = createRepoTools();
    const ctx = { directory: dir, worktree: dir } as never;
    const raw = JSON.parse(
      (await tools.workflow_branch_setup.execute(
        {
          confirmed: true,
          target_branch: "feature/new",
        },
        ctx,
      )) as string,
    );
    expect(raw.ok).toBe(false);
    expect(raw.ok).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docsBranch reports keep and create_from_develop and HEAD errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-docs-branch-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    run(["init", "-q", "-b", "feature/current"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(dir, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    const kept = docsBranch({ kind: "feature", workspace_root: dir });
    expect(kept.action).toBe("keep");
    expect(kept.branch).toBe("feature/current");

    run(["checkout", "-q", "-b", "develop"]);
    mkdirSync(path.join(dir, "docs", "x"), { recursive: true });
    writeFileSync(path.join(dir, "docs/x/plan.md"), "# X\n");
    const created = docsBranch({
      plan_path: "docs/x/plan.md",
      kind: "bugfix",
      workspace_root: dir,
    });
    expect(created.action).toBe("create_from_develop");
    expect(created.branch).toBe("bugfix/x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { writeConfig } from "../../packages/workit-core/src/core/config";

test("branch policy rejects codex/ under gitflow and allows under custom", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    const repo = mkdtempSync(path.join(os.tmpdir(), "wf-branch-policy-repo-"));
    try {
      const run = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      run(["init", "-q", "-b", "develop"]);
      run(["config", "user.name", "T"]);
      run(["config", "user.email", "t@t"]);
      writeFileSync(path.join(repo, "r.md"), "x");
      run(["add", "r.md"]);
      run(["commit", "-q", "-m", "base"]);
      run(["checkout", "-q", "-b", "main"]);
      mkdirSync(path.join(repo, "docs", "codex-feat"), { recursive: true });
      writeFileSync(
        path.join(repo, "docs/codex-feat/spec.md"),
        "# S\n\n**Branch:** `codex/feature/x`\n",
      );
      writeFileSync(
        path.join(repo, "docs/codex-feat/plan.md"),
        "# P\n\n**Spec:** `docs/codex-feat/spec.md`\n**Branch:** `codex/feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
      );

      const gitflowRes = resolveBranch({
        spec_path: "docs/codex-feat/spec.md",
        plan_path: "docs/codex-feat/plan.md",
        workspace_root: repo,
      });
      expect("error" in gitflowRes).toBe(true);

      writeConfig({
        locale: "en",
        localeOptions: ["en"],
        timezone: "UTC",
        branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
      });
      const customRes = resolveBranch({
        spec_path: "docs/codex-feat/spec.md",
        plan_path: "docs/codex-feat/plan.md",
        workspace_root: repo,
      });
      expect("error" in customRes).toBe(false);
      if (!("error" in customRes)) expect(customRes.branch).toBe("codex/feature/x");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
