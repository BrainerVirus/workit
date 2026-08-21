import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";

test("workit_docs_validate includes quality findings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-quality-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const raw = await createSddTools(new WorkflowStateStore()).workit_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.data.quality)).toBe(true);
    expect(out.data.quality.length).toBeGreaterThan(0);
    expect(out.data.quality[0]).toHaveProperty("severity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
