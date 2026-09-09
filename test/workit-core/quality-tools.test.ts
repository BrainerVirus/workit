import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { docsValidate } from "../../packages/workit-core/src/core/docs-validate";

test("docsValidate includes quality findings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-quality-"));
  try {
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    const out = docsValidate({
      spec_path: "docs/x/spec.md",
      plan_path: "docs/x/plan.md",
      workspace_root: root,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Array.isArray(out.quality)).toBe(true);
    expect(out.quality.length).toBeGreaterThan(0);
    expect(out.quality[0]).toHaveProperty("severity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
