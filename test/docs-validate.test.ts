import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../packages/workit-core/src/tools/sdd";
import { WorkflowStateStore } from "../packages/workit-core/src/state";

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

test("sdd_not_ignored when sdd dir exists and is not gitignored", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-ignore-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(out.data.quality.some((f: any) => f.code === "sdd_not_ignored")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no sdd_not_ignored when sdd is gitignored", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-ignore-ok-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.data.quality.some((f: any) => f.code === "sdd_not_ignored")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("docsValidate reports hygiene warnings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-validate-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(path.join(root, "docs/x/plan.md"), "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n");

    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: "docs/x/spec.md", plan_path: "docs/x/plan.md" },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    const codes = out.data.quality.map((f: any) => f.code);
    expect(codes).toContain("changelog_missing");
    expect(codes).toContain("readme_missing");
    expect(codes).toContain("editorconfig_missing");
    expect(codes).toContain("gitattributes_missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
