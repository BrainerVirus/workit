import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { docsValidate } from "@/packages/workit-core/src/core/docs-validate";

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

test("docsValidate accepts a contiguous linked pair", () => {
  const { root, spec, plan } = fixture();
  try {
    const result = docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task_count).toBe(2);
    expect(result.branch).toBe("feature/gates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate hard-fails on task number gap", () => {
  const { root, spec, plan } = fixture();
  writeFileSync(
    path.join(root, plan),
    `# Gates Plan\n\n**Spec:** \`${spec}\`\n**Branch:** \`feature/gates\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n\n### Task 3: Skip\n\n- [ ] **Step 1: x**\n`,
  );
  try {
    const result = docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.error)).toMatch(/task/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate hard-fails on Spec link or branch mismatch", () => {
  const { root, spec, plan } = fixture();
  writeFileSync(
    path.join(root, plan),
    `# Gates Plan\n\n**Spec:** \`docs/other/spec.md\`\n**Branch:** \`feature/other\`\n\n### Task 1: One\n\n- [ ] **Step 1: x**\n`,
  );
  try {
    expect(docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root }).ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sdd_not_ignored when sdd dir exists and is not gitignored", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-sdd-ignore-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
    mkdirSync(path.join(root, "docs", "x"), { recursive: true });
    mkdirSync(path.join(root, "docs", "x", "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs/x/spec.md"), "# Spec\n\n**Branch:** `feature/x`\n");
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const out = docsValidate({
      spec_path: "docs/x/spec.md",
      plan_path: "docs/x/plan.md",
      workspace_root: root,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.quality.some((f) => f.code === "sdd_not_ignored")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no sdd_not_ignored when sdd is gitignored", () => {
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
    writeFileSync(
      path.join(root, "docs/x/plan.md"),
      "# Plan\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
    );
    writeFileSync(path.join(root, "docs/x/sdd/progress.md"), "Task 1: complete\n");

    const out = docsValidate({
      spec_path: "docs/x/spec.md",
      plan_path: "docs/x/plan.md",
      workspace_root: root,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.quality.some((f) => f.code === "sdd_not_ignored")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate rejects cross-slug pairs through the shared resolver", () => {
  const { root } = fixture();
  try {
    mkdirSync(path.join(root, "docs", "other"), { recursive: true });
    writeFileSync(path.join(root, "docs/other/spec.md"), "# Other\n");
    const result = docsValidate({
      spec_path: "docs/2026-08-04-gates/spec.md",
      plan_path: "docs/other/plan.md",
      workspace_root: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cross-slug|shared|contract|docs\//i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate rejects wrong basenames through the shared resolver", () => {
  const { root, plan } = fixture();
  try {
    const result = docsValidate({
      spec_path: "docs/2026-08-04-gates/spec.txt",
      plan_path: plan,
      workspace_root: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/docs\/<slug>\/\(spec\|plan\)\.md/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate rejects traversal through the shared resolver", () => {
  const { root, spec } = fixture();
  try {
    const result = docsValidate({
      spec_path: spec,
      plan_path: "docs/../outside/plan.md",
      workspace_root: root,
    });
    expect(result.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate rejects absolute paths through the shared resolver", () => {
  const { root, spec, plan } = fixture();
  try {
    const result = docsValidate({
      spec_path: path.join(root, spec),
      plan_path: plan,
      workspace_root: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/absolute/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docsValidate reports hygiene warnings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-hygiene-validate-"));
  try {
    const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "T"]);
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
    const codes = out.quality.map((f) => f.code);
    expect(codes).toContain("changelog_missing");
    expect(codes).toContain("readme_missing");
    expect(codes).toContain("editorconfig_missing");
    expect(codes).toContain("gitattributes_missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
