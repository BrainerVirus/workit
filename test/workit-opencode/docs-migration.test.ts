import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDocsRepoTools } from "../../packages/workit-opencode/src/tools/docs-repo";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wf-migrate-open-"));
const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const legacySpec = (name: string) => `# Spec ${name}\n\n**Branch:** \`feature/${name}\`\n`;
const legacyPlan = (name: string) =>
  `# Plan ${name}\n\n**Spec:** \`docs/superpowers/${name}/spec.md\`\n**Branch:** \`feature/${name}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`;

const putLegacy = (root: string, name: string) => {
  mkdirSync(path.join(root, "docs", "superpowers", name), { recursive: true });
  writeFileSync(path.join(root, "docs", "superpowers", name, "spec.md"), legacySpec(name), "utf8");
  writeFileSync(path.join(root, "docs", "superpowers", name, "plan.md"), legacyPlan(name), "utf8");
};

const run = async (args: any, directory: string) => {
  const tools = createDocsRepoTools();
  const raw = await tools.workflow_docs_layout.execute(args, { directory } as never);
  return JSON.parse(raw as string);
};

test("opencode migrate preflight surfaces the exact native question choices", async () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    const out = await run({ action: "migrate", slug: "foo" }, root);
    expect(out.ok).toBe(true);
    expect(out.data.action).toBe("migrate");
    expect(out.data.stage).toBe("awaiting_confirmation");
    expect(out.data.question.options).toEqual(["Migrate safely", "Not now"]);
    expect(out.data.question.prompt).toBeTruthy();
    expect(out.data.detect.paired.length).toBe(1);
    // preflight writes nothing
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("opencode Not now declines without writes and flags the active workflow", async () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    const out = await run({ action: "migrate", slug: "foo", confirmed: false }, root);
    expect(out.ok).toBe(true);
    expect(out.data.stage).toBe("declined");
    expect(out.data.active_workflow).toBe(true);
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
    expect(readFileSync(path.join(root, "docs", "superpowers", "foo", "spec.md"), "utf8")).toBe(
      legacySpec("foo"),
    );
  } finally {
    cleanup(root);
  }
});

test("opencode Migrate safely copies the workflow and rewrites the copied plan link", async () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    const out = await run({ action: "migrate", slug: "foo", confirmed: true }, root);
    expect(out.ok).toBe(true);
    expect(out.data.copied).toContain("docs/foo/spec.md");
    expect(out.data.rewritten).toContain("docs/foo/plan.md");
    const planText = readFileSync(path.join(root, "docs", "foo", "plan.md"), "utf8");
    expect(planText).toContain("**Spec:** `docs/foo/spec.md`");
    // source stays untouched
    expect(readFileSync(path.join(root, "docs", "superpowers", "foo", "plan.md"), "utf8")).toBe(
      legacyPlan("foo"),
    );
  } finally {
    cleanup(root);
  }
});

test("opencode prepare still works when no migrate action is requested", async () => {
  const root = tmp();
  try {
    const out = await run({ slug: "fresh-open-slug" }, root);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", "fresh-open-slug"))).toBe(true);
  } finally {
    cleanup(root);
  }
});
