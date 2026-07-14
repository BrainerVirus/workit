import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";

test("plan parser returns only top-level Task sections and records state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-"));
  mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
  mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
  writeFileSync(path.join(root, "docs/superpowers/specs/x-design.md"), "# X\n**Branch:** `feature/x`\n");
  writeFileSync(path.join(root, "docs/superpowers/plans/x.md"), "# X\n**Spec:** `docs/superpowers/specs/x-design.md`\n### Task 1: One\n- [ ] Step\n### Task 2: Two\n- [ ] Step\n");
  const state = new WorkflowStateStore();
  const tools = createSddTools(state);
  const raw = await tools.workflow_plan_tasks.execute({ plan_path: "docs/superpowers/plans/x.md" }, { worktree: root, sessionID: "s1" } as never);
  const result = JSON.parse(raw as string);
  expect(result.data.tasks.map((task: any) => task.title)).toEqual(["One", "Two"]);
  expect(state.get("s1")).toEqual({
    spec: "docs/superpowers/specs/x-design.md",
    plan: "docs/superpowers/plans/x.md",
    sdd: "docs/superpowers/sdd/x",
  });
});

test("SDD paths outside the repository are rejected", async () => {
  const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
    { plan_path: "../outside.md" }, { worktree: os.tmpdir(), sessionID: "s1" } as never,
  );
  expect(JSON.parse(raw as string).error).toContain("inside repository root");
});

test("SDD tools expose standard schemas and guard writes", async () => {
  const tools = createSddTools(new WorkflowStateStore());
  expect(Object.keys(tools).sort()).toEqual([
    "workflow_plan_tasks", "workflow_resolve_branch", "workflow_sdd_context",
    "workflow_sdd_task_brief", "workflow_sdd_review_package", "workflow_sdd_append_progress",
  ].sort());
  for (const definition of Object.values(tools)) {
    expect("workspace_root" in definition.args).toBe(false);
  }
  for (const name of [
    "workflow_sdd_task_brief", "workflow_sdd_review_package", "workflow_sdd_append_progress",
  ] as const) {
    const raw = await tools[name].execute({ confirmed: false } as never, { worktree: "/repo" } as never);
    expect(JSON.parse(raw as string).error).toBe("confirmed: true required");
  }
});

test("confirmed SDD writes use repository-relative paths and standard results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-write-"));
  const tools = createSddTools(new WorkflowStateStore());
  const brief = JSON.parse(await tools.workflow_sdd_task_brief.execute({
    confirmed: true,
    sdd_dir: "docs/superpowers/sdd/x",
    task_id: 2,
    section_text: "- [ ] Implement it\n",
  }, { worktree: root } as never) as string);
  expect(brief.data.brief_path).toBe("docs/superpowers/sdd/x/task-2-brief.md");
  expect(readFileSync(path.join(root, brief.data.brief_path), "utf8")).toContain("Implement it");

  const progress = JSON.parse(await tools.workflow_sdd_append_progress.execute({
    confirmed: true,
    progress_path: "docs/superpowers/sdd/x/progress.md",
    line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
  }, { worktree: root } as never) as string);
  expect(progress).toEqual({
    ok: true,
    data: {
      line: "Task 2: complete (commits abcdef0..1234567, tests pass)",
      progress_path: "docs/superpowers/sdd/x/progress.md",
    },
    error: null,
  });
});
