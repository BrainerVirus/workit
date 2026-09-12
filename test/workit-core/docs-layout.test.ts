import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { docsValidate } from "@/packages/workit-core/src/core/docs-validate";
import { createDocsRepoTools } from "@/packages/workit-opencode/src/tools/docs-repo";
import { resolveCanonicalLayout } from "@/packages/workit-core/src/core/docs-layout";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-layout-"));
  const slug = "add-some-awesome-feat";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
  writeFileSync(
    path.join(root, "docs", slug, "spec.md"),
    `# Spec\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`,
  );
  writeFileSync(
    path.join(root, "docs", slug, "plan.md"),
    `# Plan\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`,
  );
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("docs validate passes on the new layout", () => {
  const { root, slug } = fixture();
  try {
    expect(
      docsValidate({
        spec_path: `docs/${slug}/spec.md`,
        plan_path: `docs/${slug}/plan.md`,
        workspace_root: root,
      }).ok,
    ).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("docs validate rejects absolute paths through the shared resolver", () => {
  const { root, slug } = fixture();
  try {
    expect(
      docsValidate({
        spec_path: path.join(root, "docs", slug, "spec.md"),
        plan_path: `docs/${slug}/plan.md`,
        workspace_root: root,
      }).ok,
    ).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("docs validate rejects cross-slug pairs through the shared resolver", () => {
  const { root, slug } = fixture();
  try {
    mkdirSync(path.join(root, "docs", "other"), { recursive: true });
    writeFileSync(path.join(root, "docs/other/spec.md"), "# Other\n");
    const out = docsValidate({
      spec_path: `docs/${slug}/spec.md`,
      plan_path: "docs/other/plan.md",
      workspace_root: root,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(String(out.error)).toMatch(/cross-slug|docs\//i);
  } finally {
    cleanup(root);
  }
});

test("DC-01: resolveCanonicalLayout accepts the exact canonical spelling", () => {
  const { root, slug } = fixture();
  try {
    const res = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(res.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("DC-01: resolveCanonicalLayout rejects ./docs/<slug>/spec.md spelling", () => {
  const { root, slug } = fixture();
  try {
    const res = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: `./docs/${slug}/spec.md`,
    });
    expect(res.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("DC-01: resolveCanonicalLayout rejects docs/<slug>/../<slug>/spec.md traversal spelling", () => {
  const { root, slug } = fixture();
  try {
    const res = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: `docs/${slug}/../${slug}/spec.md`,
    });
    expect(res.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("DC-01: resolveCanonicalLayout rejects repeated separators", () => {
  const { root, slug } = fixture();
  try {
    const a = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs//${slug}/spec.md` });
    expect(a.ok).toBe(false);
    const b = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs/${slug}//spec.md` });
    expect(b.ok).toBe(false);
    const c = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs/${slug}/spec.md/` });
    expect(c.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("DC-01: resolveCanonicalLayout rejects absolute paths and traversal", () => {
  const { root, slug } = fixture();
  try {
    const abs = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: path.join(root, "docs", slug, "spec.md"),
    });
    expect(abs.ok).toBe(false);
    if (!abs.ok) expect(abs.error).toMatch(/absolute/i);
    const up = resolveCanonicalLayout({ workspace_root: root, spec_path: "../outside.md" });
    expect(up.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("DC-02: resolveCanonicalLayout rejects symlink escapes outside the workspace", () => {
  if (process.platform === "win32") return;
  const { root, slug } = fixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), "wf-outside-"));
  try {
    rmSync(path.join(root, "docs", slug, "spec.md"), { force: true });
    writeFileSync(path.join(outside, "spec.md"), "# outside\n", "utf8");
    symlinkSync(path.join(outside, "spec.md"), path.join(root, "docs", slug, "spec.md"));
    const res = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs/${slug}/spec.md` });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/inside repository root/i);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup(root);
  }
});

test("DC-02: resolveCanonicalLayout accepts an unreadable canonical doc (macOS realpath EACCES)", () => {
  if (process.platform === "win32") return;
  const { root, slug } = fixture();
  try {
    chmodSync(path.join(root, "docs", slug, "spec.md"), 0o000);
    const res = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs/${slug}/spec.md` });
    expect(res.ok).toBe(true);
  } finally {
    chmodSync(path.join(root, "docs", slug, "spec.md"), 0o644);
    cleanup(root);
  }
});

test("DC-02: resolveCanonicalLayout rejects a symlinked docs/<slug> that resolves to another slug", () => {
  if (process.platform === "win32") return;
  const { root, slug } = fixture();
  try {
    mkdirSync(path.join(root, "docs", "other"), { recursive: true });
    writeFileSync(path.join(root, "docs", "other", "spec.md"), "# other\n", "utf8");
    rmSync(path.join(root, "docs", slug), { recursive: true, force: true });
    symlinkSync(path.join(root, "docs", "other"), path.join(root, "docs", slug));
    const res = resolveCanonicalLayout({ workspace_root: root, spec_path: `docs/${slug}/spec.md` });
    expect(res.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("workit_docs_layout prepare creates only missing dirs on the opencode adapter", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-layout-prepare-"));
  try {
    const tools = createDocsRepoTools();
    const raw = await tools.workit_docs_layout.execute({ slug: "fresh-layout-slug" }, {
      directory: root,
      worktree: root,
    } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug"))).toBe(true);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug", "sdd"))).toBe(false);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug", "spec.md"))).toBe(false);
  } finally {
    cleanup(root);
  }
});
