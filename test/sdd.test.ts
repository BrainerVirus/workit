import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
  writeFileSync(path.join(isolatedConfig, "config.json"), JSON.stringify({
    locale: "en",
    localeOptions: ["en"],
    timezone: "UTC",
    branchPolicy: {
      preset: "gitflow",
      allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
      protected: ["main", "develop", "master", "prod", "production"],
    },
  }, null, 2));
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

test("plan parser returns only top-level Task sections and records state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
  writeFileSync(path.join(root, "docs/x/plan.md"), "# X\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] Step\n\n### Task 2: Two\n\n- [ ] Step\n");
  const state = new WorkflowStateStore();
  const tools = createSddTools(state);
  const raw = await tools.workflow_plan_tasks.execute({ plan_path: "docs/x/plan.md" }, { directory: root, worktree: root, sessionID: "s1" } as never);
  const result = JSON.parse(raw as string);
  expect(result.data.tasks.map((task: any) => task.title)).toEqual(["One", "Two"]);
  expect(state.get("s1")).toEqual({
    spec: "docs/x/spec.md",
    plan: "docs/x/plan.md",
    sdd: "docs/x/sdd",
  });
});

test("plan parser honors an explicit contained spec path and returns its branch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-spec-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  mkdirSync(path.join(root, "docs", "exact"), { recursive: true });
  mkdirSync(path.join(root, "docs", "other"), { recursive: true });
  writeFileSync(path.join(root, "docs/exact/spec.md"), "# Exact\n**Branch:** `feature/exact`\n");
  writeFileSync(path.join(root, "docs/other/spec.md"), "# Other\n**Branch:** `feature/other`\n");
  writeFileSync(path.join(root, "docs/x/plan.md"), "# X\n**Spec:** `docs/other/spec.md`\n**Branch:** `feature/other`\n\n### Task 1: One\n\n- [ ] Step\n");
  const state = new WorkflowStateStore();
  const tools = createSddTools(state);
  const raw = await tools.workflow_plan_tasks.execute({
    plan_path: "docs/x/plan.md",
    spec_path: "docs/exact/spec.md",
  }, { directory: root, worktree: root, sessionID: "spec" } as never);
  expect(JSON.parse(raw as string).data.branch).toBe("feature/exact");
  expect(state.get("spec")?.spec).toBe("docs/exact/spec.md");

  const outside = await createSddTools(new WorkflowStateStore()).workflow_plan_tasks.execute({
    plan_path: "docs/x/plan.md", spec_path: "../outside.md",
  }, { directory: root, worktree: root, sessionID: "outside" } as never);
  expect(JSON.parse(outside as string).error).toContain("inside repository root");
});

test("SDD paths outside the repository are rejected", async () => {
  const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
    { plan_path: "../outside.md" }, { directory: os.tmpdir(), worktree: os.tmpdir(), sessionID: "s1" } as never,
  );
  expect(JSON.parse(raw as string).error).toContain("inside repository root");
});

test("SDD context computes absent paths without creating repository files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-readonly-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# X\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] Step\n",
    );
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "readonly" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
    expect(existsSync(path.join(root, "docs/x/sdd"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDD tools expose standard schemas and guard writes", async () => {
  const tools = createSddTools(new WorkflowStateStore());
  expect(Object.keys(tools).sort()).toEqual([
    "workflow_docs_branch", "workflow_docs_validate", "workflow_plan_tasks", "workflow_resolve_branch", "workflow_sdd_context",
    "workflow_sdd_task_brief", "workflow_sdd_review_package", "workflow_sdd_append_progress",
  ].sort());
  for (const definition of Object.values(tools)) {
    expect("workspace_root" in definition.args).toBe(false);
  }
  for (const name of [
    "workflow_sdd_task_brief", "workflow_sdd_review_package", "workflow_sdd_append_progress",
  ] as const) {
    const raw = await tools[name].execute({ confirmed: false } as never, { directory: "/repo", worktree: "/repo"} as never);
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
  }
});

test("confirmed SDD writes use repository-relative paths and standard results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-write-"));
  const tools = createSddTools(new WorkflowStateStore());
  const brief = JSON.parse(await tools.workflow_sdd_task_brief.execute({
    confirmed: true,
    sdd_dir: "docs/x/sdd",
    task_id: 2,
    section_text: "- [ ] Implement it\n",
  }, { directory: root, worktree: root} as never) as string);
  expect(brief.data.brief_path).toBe("docs/x/sdd/task-2-brief.md");
  expect(readFileSync(path.join(root, brief.data.brief_path), "utf8")).toContain("Implement it");

  const progress = JSON.parse(await tools.workflow_sdd_append_progress.execute({
    confirmed: true,
    progress_path: "docs/x/sdd/progress.md",
    line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
  }, { directory: root, worktree: root} as never) as string);
  expect(progress).toEqual({
    ok: true,
    data: {
      line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
      progress_path: "docs/x/sdd/progress.md",
    },
    error: null,
  });
});

test("branch resolution returns repository and plan facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-branch-"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs/spec.md"), "# Spec\n**Branch:** `feature/fixture`\n");
  writeFileSync(path.join(root, "docs/plan.md"), "# Plan\n");
  expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status).toBe(0);
  spawnSync("git", ["config", "user.name", "Workflow Test"], { cwd: root });
  spawnSync("git", ["config", "user.email", "workflow@example.test"], { cwd: root });
  spawnSync("git", ["add", "docs"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  const raw = await createSddTools(new WorkflowStateStore()).workflow_resolve_branch.execute({
    spec_path: "docs/spec.md", plan_path: "docs/plan.md",
  }, { directory: root, worktree: root} as never);
  expect(JSON.parse(raw as string)).toEqual({
    ok: true,
    data: {
      branch: "feature/fixture", source: "spec", current_branch: "main",
      dirty: false, needs_checkout: true,
    },
    error: null,
  });
});

test("confirmed review package writes its diff inside the repository", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-review-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(git(["init", "-q", "-b", "feature/review"]).status).toBe(0);
  git(["config", "user.name", "Workflow Test"]);
  git(["config", "user.email", "workflow@example.test"]);
  writeFileSync(path.join(root, "file.txt"), "one\n");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(path.join(root, "file.txt"), "one\ntwo\n");
  git(["commit", "-q", "-am", "head"]);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute({
    confirmed: true, sdd_dir: "docs/review/sdd", base_sha: base, head_sha: head,
  }, { directory: root, worktree: root} as never);
  const result = JSON.parse(raw as string);
  expect(result.ok).toBe(true);
  expect(result.data.diff_path).toBe(`docs/review/sdd/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`);
  expect(readFileSync(path.join(root, result.data.diff_path), "utf8")).toContain("+two");
});

test("review package rejects unsafe revisions and quote-bearing paths cannot execute code", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-injection-"));
  const sentinel = path.join(root, "sentinel");
  try {
    const tools = createSddTools(new WorkflowStateStore());
    const raw = await tools.workflow_sdd_review_package.execute({
      confirmed: true,
      sdd_dir: "docs/quote/sdd'$(touch sentinel)",
      base_sha: "--output=outside",
      head_sha: "HEAD'; touch sentinel; #",
    }, { directory: root, worktree: root } as never);
    expect(JSON.parse(raw as string).error).toContain("invalid Git revision");
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(path.dirname(root), "outside"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review package safely writes to a quote-bearing contained path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-quoted-path-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git(["init", "-q", "-b", "feature/review"]); git(["config", "user.name", "Workflow Test"]);
    git(["config", "user.email", "workflow@example.test"]);
    writeFileSync(path.join(root, "file.txt"), "one\n"); git(["add", "."]); git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(path.join(root, "file.txt"), "two\n"); git(["commit", "-q", "-am", "head"]);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_review_package.execute({
      confirmed: true, sdd_dir: "docs/review/sdd'quoted", base_sha: base, head_sha: head,
    }, { directory: root, worktree: root } as never);
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(root, result.data.diff_path))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
