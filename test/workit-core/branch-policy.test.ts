import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import {
  docsBranch,
  resolveBranch,
  resolveBranchPolicyFor,
} from "../../packages/workit-core/src/core/branch";
import { vcsConfig } from "../../packages/workit-core/src/core/vcs-config";
import { resolvePrBranchContext } from "../../packages/workit-core/src/core/repo-context";
import { prCreate } from "../../packages/workit-core/src/core/pr-create";
import { writeConfig } from "../../packages/workit-core/src/core/config";
import { stubCli } from "../shared/helpers/stub-cli";

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

test("RL-03: every PR surface resolves the one configured target branch per preset", async () => {
  // CLI/resolve, PR context, docs branch, OpenCode tool, and Cursor create all
  // consume the same target from authoritative config — no per-surface override.
  const CASES = [
    { preset: "gitflow", target: "develop" },
    { preset: "github-flow", target: "main" },
    { preset: "trunk-based", target: "main" },
    { preset: "custom", target: "trunk" },
  ] as const;
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-rel03-bin-"));
  const logFile = path.join(stubBin, "glab-args.txt");
  stubCli(stubBin, "glab", logFile, "https://gitlab.com/o/r/-/merge_requests/1");
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = `${stubBin}${path.delimiter}${prevPath ?? ""}`;
    for (const c of CASES) {
      const { root, remote } = repoWithDevelop();
      if (c.target === "trunk") {
        git(root, ["checkout", "-q", "-b", "trunk"]);
        git(root, ["push", "-q", "-u", "origin", "trunk"]);
      }
      writeFileSync(
        path.join(isolatedConfig, "workit", "config.json"),
        JSON.stringify({
          branchPolicy: {
            preset: c.preset,
            allowed: c.preset === "custom" ? ["feature/*"] : undefined,
            protected: ["main"],
          },
        }),
      );
      writeFileSync(
        path.join(isolatedConfig, "workit", "vcs.json"),
        JSON.stringify({ provider: "gitlab", defaultTargetBranch: c.target }),
      );
      writeFileSync(path.join(isolatedConfig, "workit", "gitlab.token"), "test-token\n");
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              name: "t",
              glob: `${root}/**`,
              vcs: { provider: "gitlab", defaultTargetBranch: c.target },
              branchPolicy:
                c.preset === "custom"
                  ? { preset: "custom", allowed: ["feature/*"], protected: ["main"] }
                  : { preset: c.preset },
            },
          ],
        }),
      );
      try {
        git(root, ["checkout", "-q", "-b", "feature/rel03"]);

        // surface 1 — CLI / config resolve
        const resolved = vcsConfig("resolve", root);
        expect(resolved.defaultTargetBranch).toBe(c.target);

        // surface 2 — PR context base_ref
        const ctx = resolvePrBranchContext(root);
        expect(ctx.ok, `${c.preset}: ${ctx.ok === false ? ctx.error : ""}`).toBe(true);
        if (ctx.ok) expect([`origin/${c.target}`, c.target]).toContain(ctx.value.baseRef);

        // surface 3 — docs branch base
        const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
        expect("error" in db).toBe(false);
        if (!("error" in db)) expect(db.base).toBe(c.target);

        // surface 4 — OpenCode workflow_pr_create
        const raw = await createRepoTools().workflow_pr_create.execute(
          { confirmed: true, title: "T" },
          { directory: root, worktree: root } as never,
        );
        const toolResult = JSON.parse(raw as string);
        expect(toolResult.ok, `${c.preset}: ${JSON.stringify(toolResult)}`).toBe(true);
        expect(toolResult.data.targetBranch).toBe(c.target);

        // surface 5 — Cursor workflow_pr_create. This calls core prCreate
        // directly rather than packages/workit-cursor/mcp/server.ts: the MCP
        // adapter's workflow_pr_create handler is a thin passthrough — it
        // registers the tool, requires confirmed:true, then calls prCreate
        // with the same 5 WF_PR_* keys (mcp/server.ts) — and exercising it
        // needs a full stdio MCP client. The adapter wiring is asserted by
        // source scans in test/workit-cursor/mcp-regressions.test.ts. B1's
        // override validation lives in prCreate itself, so this surface is
        // covered here exactly as the adapter would invoke it.
        const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
        expect(p.ok, `${c.preset}: ${JSON.stringify(p)}`).toBe(true);
        expect(p.targetBranch).toBe(c.target);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(remote, { recursive: true, force: true });
      }
    }
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(stubBin, { recursive: true, force: true });
  }
});

test("CA-01: workspace branchPolicy overrides global config policy across consumers", async () => {
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-ca01-bin-"));
  const logFile = path.join(stubBin, "glab-args.txt");
  stubCli(stubBin, "glab", logFile, "https://gitlab.com/o/r/-/merge_requests/1");
  const prevPath = process.env.PATH;
  const { root, remote } = repoWithDevelop();
  try {
    process.env.PATH = `${stubBin}${path.delimiter}${prevPath ?? ""}`;
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            name: "w",
            glob: `${root}/**`,
            branchPolicy: { preset: "gitflow", integration: "merge" },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "vcs.json"),
      JSON.stringify({ provider: "gitlab", defaultTargetBranch: "develop" }),
    );
    writeFileSync(path.join(isolatedConfig, "workit", "gitlab.token"), "test-token\n");
    git(root, ["checkout", "-q", "-b", "feature/rel03"]);
    const pol = resolveBranchPolicyFor(root);
    expect(pol.preset).toBe("gitflow");
    expect(pol.integration).toBe("merge");
    expect(pol.protected).toContain("develop");
    const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
    expect(db.base).toBe("develop");
    const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, root);
    expect(p.ok, JSON.stringify(p)).toBe(true);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("CA-01: unmatched repo falls back to global policy, then preset defaults", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(path.join(isolatedConfig, "workit", "workspaces.json"), '{"workspaces":[]}');
    git(root, ["checkout", "-q", "-b", "feature/x"]);
    expect(resolveBranchPolicyFor(root).preset).toBe("github-flow");
    rmSync(path.join(isolatedConfig, "workit", "config.json"), { force: true });
    expect(resolveBranchPolicyFor(root).preset).toBe("gitflow"); // PRESETS default
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("CA-05: defaultTargetBranch is preset-aware when unset", async () => {
  // vcs.defaultTargetBranch stays consistent when unset: github-flow -> main,
  // gitflow -> develop. Explicit workspace/global values still win (RL-03).
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-ca05-bin-"));
  const ghLog = path.join(stubBin, "gh-args.txt");
  stubCli(stubBin, "gh", ghLog, "https://github.com/o/r/pull/1");
  const prevPath = process.env.PATH;
  const mainOnlyRepo = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wf-ca05-main-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "Workflow Test"]);
    git(dir, ["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(dir, "README.md"), "base\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    return dir;
  };
  try {
    process.env.PATH = `${stubBin}${path.delimiter}${prevPath ?? ""}`;
    const mainOnly = mainOnlyRepo();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [
            { name: "w", glob: `${mainOnly}/**`, branchPolicy: { preset: "github-flow" } },
          ],
        }),
      );
      writeFileSync(
        path.join(isolatedConfig, "workit", "vcs.json"),
        JSON.stringify({ provider: "github" }),
      );
      writeFileSync(path.join(isolatedConfig, "workit", "github.token"), "test-token\n");
      mkdirSync(path.join(mainOnly, "docs", "x"), { recursive: true });
      writeFileSync(path.join(mainOnly, "docs/x/plan.md"), "# Plan\n");
      expect(vcsConfig("resolve", mainOnly).defaultTargetBranch).toBe("main");
      const db = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: mainOnly });
      expect("error" in db).toBe(false);
      if (!("error" in db)) expect(db.base).toBe("main");
      const p = prCreate({ WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T" }, mainOnly);
      expect(p.ok, JSON.stringify(p)).toBe(true);
      expect(p.targetBranch).toBe("main");
    } finally {
      rmSync(mainOnly, { recursive: true, force: true });
    }
    const { root, remote } = repoWithDevelop();
    try {
      writeFileSync(
        path.join(isolatedConfig, "workit", "workspaces.json"),
        JSON.stringify({
          workspaces: [{ name: "w", glob: `${root}/**`, branchPolicy: { preset: "gitflow" } }],
        }),
      );
      writeFileSync(
        path.join(isolatedConfig, "workit", "vcs.json"),
        JSON.stringify({ provider: "github" }),
      );
      git(root, ["checkout", "-q", "-b", "feature/ca05"]);
      expect(vcsConfig("resolve", root).defaultTargetBranch).toBe("develop");
      const db2 = docsBranch({ plan_path: "docs/x/plan.md", workspace_root: root });
      expect("error" in db2).toBe(false);
      if (!("error" in db2)) expect(db2.base).toBe("develop");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(stubBin, { recursive: true, force: true });
  }
});

test("workspace preset typo falls back to the global preset without crashing", async () => {
  const { root, remote } = repoWithDevelop();
  try {
    writeFileSync(
      path.join(isolatedConfig, "workit", "config.json"),
      JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
    );
    writeFileSync(
      path.join(isolatedConfig, "workit", "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "w", glob: `${root}/**`, branchPolicy: { preset: "gitflo" } }],
      }),
    );
    expect(() => resolveBranchPolicyFor(root)).not.toThrow();
    expect(resolveBranchPolicyFor(root).preset).toBe("github-flow");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("RL-03b: provider reconciles with the actual origin remote across PR surfaces", async () => {
  // A stale config provider (gitlab) must not drive glab on a github.com-hosted
  // repo: vcsConfig load/resolve and prCreate derive the provider from the
  // origin remote when no explicit workspace vcs.provider overrides it.
  const stubBin = mkdtempSync(path.join(os.tmpdir(), "wf-remote-bin-"));
  const ghLog = path.join(stubBin, "gh-args.txt");
  const glabLog = path.join(stubBin, "glab-args.txt");
  stubCli(stubBin, "gh", ghLog, "https://github.com/acme/workit/pull/1");
  stubCli(stubBin, "glab", glabLog, "https://gitlab.com/acme/workit/-/merge_requests/1");
  const cfgDir = mkdtempSync(path.join(os.tmpdir(), "wf-remote-cfg-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  const prevPath = process.env.PATH;
  const writeCfg = (provider: string) => {
    writeFileSync(
      path.join(cfgDir, "vcs.json"),
      JSON.stringify({ provider, defaultTargetBranch: "main" }),
    );
    writeFileSync(path.join(cfgDir, "gitlab.token"), "gitlab-token\n", { mode: 0o600 });
    writeFileSync(path.join(cfgDir, "github.token"), "github-token\n", { mode: 0o600 });
  };
  const repoWithRemote = (url: string) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-remote-repo-"));
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q", "-b", "feature/t"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(root, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    run(["remote", "add", "origin", url]);
    return root;
  };
  try {
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfgDir;
    process.env.PATH = `${stubBin}${path.delimiter}${prevPath ?? ""}`;
    const ghRoot = repoWithRemote("https://github.com/acme/workit.git");
    try {
      writeCfg("gitlab");
      expect(vcsConfig("resolve", ghRoot).provider).toBe("github");
      const loaded = vcsConfig("load", ghRoot);
      expect(loaded.provider).toBe("github");
      expect(String(loaded.tokenPath)).toEndWith("github.token");
      const p = prCreate(
        { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "", WF_PR_DRAFT: "false" },
        ghRoot,
      );
      expect(p.ok, JSON.stringify(p)).toBe(true);
      expect(p.provider).toBe("github");
      expect(existsSync(glabLog)).toBe(false);
      expect(readFileSync(ghLog, "utf8")).toContain("pr create");
    } finally {
      rmSync(ghRoot, { recursive: true, force: true });
    }
    rmSync(glabLog, { force: true });
    rmSync(ghLog, { force: true });
    const glRoot = repoWithRemote("https://gitlab.com/acme/workit.git");
    try {
      writeCfg("github");
      expect(vcsConfig("resolve", glRoot).provider).toBe("gitlab");
      const p = prCreate(
        { WF_PR_CONFIRMED: "true", WF_PR_TITLE: "T", WF_PR_BODY: "", WF_PR_DRAFT: "false" },
        glRoot,
      );
      expect(p.ok, JSON.stringify(p)).toBe(true);
      expect(p.provider).toBe("gitlab");
      expect(existsSync(ghLog)).toBe(false);
      expect(readFileSync(glabLog, "utf8")).toContain("mr create");
    } finally {
      rmSync(glRoot, { recursive: true, force: true });
    }
  } finally {
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(stubBin, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("RL-01: malformed config.json throws the exact-path error from policy-aware resolve", () => {
  // The now-policy-aware vcs resolve and resolveBranchPolicyFor both call
  // readConfig(), which throws on malformed config.json instead of silently
  // falling back to defaults — the diagnostic carries the exact file path.
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-malformed-cfg-repo-"));
  const cfg = mkdtempSync(path.join(os.tmpdir(), "wf-malformed-cfg-"));
  const prevConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(path.join(root, "r.md"), "x");
    run(["add", "r.md"]);
    run(["commit", "-q", "-m", "base"]);
    writeFileSync(path.join(cfg, "config.json"), "{ not json\n", "utf8");
    process.env.WORKFLOW_TOOLKIT_CONFIG = cfg;
    expect(() => vcsConfig("resolve", root)).toThrow(/is not valid JSON/);
    expect(() => resolveBranchPolicyFor(root)).toThrow(/is not valid JSON/);
  } finally {
    if (prevConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prevConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

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
