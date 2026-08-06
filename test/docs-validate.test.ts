import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-docs-validate-"));
  mkdirSync(path.join(root, "docs", "2026-08-04-gates"), { recursive: true });
  const spec = "docs/2026-08-04-gates/spec.md";
  const plan = "docs/2026-08-04-gates/plan.md";
  writeFileSync(path.join(root, spec), "# Gates\n\n**Branch:** `feature/gates`\n");
  writeFileSync(
    path.join(root, plan),
    `# Gates Plan\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gates\`\n\n### Task 1: One\n\n- [ ] **Step 1: Do it**\n\n### Task 2: Two\n\n- [ ] **Step 1: Do it**\n`,
  );
  return { root, spec, plan };
};

test("workflow_docs_validate accepts a contiguous linked pair", async () => {
  const { root, spec, plan } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(true);
    expect(result.data.task_count).toBe(2);
    expect(result.data.branch).toBe("feature/gates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_docs_validate hard-fails on task number gap", async () => {
  const { root, spec, plan } = fixture();
  writeFileSync(
    path.join(root, plan),
    `# Gates Plan\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gates\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n\n### Task 3: Skip\n\n- [ ] **Step 1: x**\n`,
  );
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    const result = JSON.parse(raw as string);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/task/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_docs_validate hard-fails on Spec link or branch mismatch", async () => {
  const { root, spec, plan } = fixture();
  writeFileSync(
    path.join(root, plan),
    `# Gates Plan\n\n**Spec:** \`docs/other/spec.md\`\n**Branch:** \`feature/other\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n`,
  );
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: spec, plan_path: plan },
      { directory: root, worktree: root, sessionID: "t" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
