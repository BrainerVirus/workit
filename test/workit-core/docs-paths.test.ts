import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareDocsLayout,
  probeLegacyDocs,
  resolveCanonicalLayout,
} from "../../packages/workit-core/src/core/docs-layout";
import { createDocsRepoTools } from "../../packages/workit-opencode/src/tools/docs-repo";

const posix = (p: string) => p.split(path.sep).join("/");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wf-docspaths-"));
const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });
const slug = "add-awesome-feature";

const makePair = (root: string, s: string) => {
  mkdirSync(path.join(root, "docs", s), { recursive: true });
  writeFileSync(
    path.join(root, "docs", s, "spec.md"),
    `# Spec ${s}\n\n**Branch:** \`feature/${s}\`\n`,
  );
  writeFileSync(
    path.join(root, "docs", s, "plan.md"),
    `# Plan ${s}\n\n**Spec:** \`docs/${s}/spec.md\`\n**Branch:** \`feature/${s}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`,
  );
};

test("resolver returns a canonical pair without creating anything", () => {
  const root = tmp();
  try {
    makePair(root, slug);
    const res = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.layout.slug).toBe(slug);
    expect(res.layout.workspace).toBe(realpathSync(root));
    expect(res.layout.dir).toBe(realpathSync(path.join(root, "docs", slug)));
    expect(res.layout.spec).toBe(path.join(res.layout.dir, "spec.md"));
    expect(res.layout.plan).toBe(path.join(res.layout.dir, "plan.md"));
    expect(res.layout.sdd).toBe(path.join(res.layout.dir, "sdd"));
  } finally {
    cleanup(root);
  }
});

test("resolver does not create missing dirs (prepare is explicit)", () => {
  const root = tmp();
  try {
    const res = resolveCanonicalLayout({ workspace_root: root, slug });
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(root, "docs"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("prepare creates only missing docs/ and docs/<slug>/", () => {
  const root = tmp();
  try {
    const res = prepareDocsLayout({ workspace_root: root, slug });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created.sort()).toEqual(["docs", `docs/${slug}`]);
    expect(readdirSync(root).sort()).toEqual(["docs"]);
    expect(readdirSync(path.join(root, "docs")).sort()).toEqual([slug]);
    expect(readdirSync(path.join(root, "docs", slug)).sort()).toEqual([]);
    expect(existsSync(path.join(root, "docs", slug, "sdd"))).toBe(false);
    expect(res.layout.workspace).toBe(realpathSync(root));
    expect(res.layout.dir).toBe(realpathSync(path.join(root, "docs", slug)));
    expect(res.layout.spec).toBe(path.join(res.layout.dir, "spec.md"));
    expect(res.layout.plan).toBe(path.join(res.layout.dir, "plan.md"));
  } finally {
    cleanup(root);
  }
});

test("prepare is idempotent and creates nothing on the second call", () => {
  const root = tmp();
  try {
    const first = prepareDocsLayout({ workspace_root: root, slug });
    const second = prepareDocsLayout({ workspace_root: root, slug });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.created).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("absolute paths are rejected", () => {
  const root = tmp();
  try {
    makePair(root, slug);
    const abs = path.join(root, "docs", slug, "spec.md");
    const res = resolveCanonicalLayout({ workspace_root: root, spec_path: abs });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/absolute/i);
    const plan = resolveCanonicalLayout({
      workspace_root: root,
      plan_path: path.join(root, "docs", slug, "plan.md"),
    });
    expect(plan.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("traversal paths are rejected", () => {
  const root = tmp();
  try {
    const outside = resolveCanonicalLayout({ workspace_root: root, plan_path: "../outside.md" });
    expect(outside.ok).toBe(false);
    const up = resolveCanonicalLayout({ workspace_root: root, spec_path: "docs/../spec.md" });
    expect(up.ok).toBe(false);
    const dirs = resolveCanonicalLayout({
      workspace_root: root,
      plan_path: "docs/x/../../plan.md",
    });
    expect(dirs.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("symlink escapes are rejected", () => {
  const root = tmp();
  const outside = tmp();
  try {
    mkdirSync(path.join(root, "docs"), { recursive: true });
    symlinkSync(outside, path.join(root, "docs", "evil"));
    const bySlug = resolveCanonicalLayout({ workspace_root: root, slug: "evil" });
    expect(bySlug.ok).toBe(false);
    if (!bySlug.ok) expect(bySlug.error).toMatch(/inside repository root/i);
    const byPath = resolveCanonicalLayout({
      workspace_root: root,
      plan_path: "docs/evil/plan.md",
    });
    expect(byPath.ok).toBe(false);
    const prepared = prepareDocsLayout({ workspace_root: root, slug: "evil" });
    expect(prepared.ok).toBe(false);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test("cross-slug pairs are rejected", () => {
  const root = tmp();
  try {
    makePair(root, "a");
    makePair(root, "b");
    const res = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: "docs/a/spec.md",
      plan_path: "docs/b/plan.md",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cross-slug/i);
  } finally {
    cleanup(root);
  }
});

test("slug/path mismatch is rejected", () => {
  const root = tmp();
  try {
    makePair(root, "a");
    makePair(root, "b");
    const res = resolveCanonicalLayout({
      workspace_root: root,
      slug: "a",
      plan_path: "docs/b/plan.md",
    });
    expect(res.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("wrong basenames are rejected", () => {
  const root = tmp();
  try {
    makePair(root, slug);
    expect(resolveCanonicalLayout({ workspace_root: root, spec_path: "docs/x/spec.txt" }).ok).toBe(
      false,
    );
    expect(resolveCanonicalLayout({ workspace_root: root, plan_path: "docs/x/notes.md" }).ok).toBe(
      false,
    );
    expect(resolveCanonicalLayout({ workspace_root: root, spec_path: "docs/x/plan.md" }).ok).toBe(
      false,
    );
    expect(resolveCanonicalLayout({ workspace_root: root, plan_path: "docs/x/spec.md" }).ok).toBe(
      false,
    );
  } finally {
    cleanup(root);
  }
});

test("arbitrary and legacy paths are rejected", () => {
  const root = tmp();
  try {
    expect(
      resolveCanonicalLayout({ workspace_root: root, plan_path: "docs/superpowers/plan.md" }).ok,
    ).toBe(false);
    expect(resolveCanonicalLayout({ workspace_root: root, plan_path: "specs/x/plan.md" }).ok).toBe(
      false,
    );
    expect(resolveCanonicalLayout({ workspace_root: root, plan_path: "plans/x/plan.md" }).ok).toBe(
      false,
    );
    expect(
      resolveCanonicalLayout({ workspace_root: root, plan_path: ".superpowers/sdd/progress.md" })
        .ok,
    ).toBe(false);
    expect(
      resolveCanonicalLayout({ workspace_root: root, plan_path: "docs/x/sdd/progress.md" }).ok,
    ).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("canonical returned paths resolve realpath through a workspace alias", () => {
  const root = tmp();
  const aliasRoot = tmp();
  try {
    const alias = path.join(aliasRoot, "alias");
    symlinkSync(root, alias);
    const res = prepareDocsLayout({ workspace_root: alias, slug });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.layout.workspace).toBe(realpathSync(root));
    expect(res.layout.dir).toBe(realpathSync(path.join(root, "docs", slug)));
    expect(realpathSync(res.layout.dir)).toBe(res.layout.dir);
    expect(existsSync(res.layout.spec) || !existsSync(res.layout.spec)).toBe(true);
  } finally {
    cleanup(root);
    cleanup(aliasRoot);
  }
});

test("Cursor/OpenCode root parity: slug and pair resolution agree on canonical paths", () => {
  const root = tmp();
  try {
    makePair(root, slug);
    const bySlug = resolveCanonicalLayout({ workspace_root: root, slug });
    const byPair = resolveCanonicalLayout({
      workspace_root: root,
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(bySlug.ok && byPair.ok).toBe(true);
    if (bySlug.ok && byPair.ok) {
      expect(bySlug.layout).toEqual(byPair.layout);
    }
  } finally {
    cleanup(root);
  }
});

test("Cursor/OpenCode root parity: alias root resolves to the same canonical workspace", () => {
  const root = tmp();
  const aliasRoot = tmp();
  try {
    makePair(root, slug);
    const alias = path.join(aliasRoot, "alias");
    symlinkSync(root, alias);
    const viaRoot = resolveCanonicalLayout({ workspace_root: root, slug });
    const viaAlias = resolveCanonicalLayout({ workspace_root: alias, slug });
    expect(viaRoot.ok && viaAlias.ok).toBe(true);
    if (viaRoot.ok && viaAlias.ok) {
      expect(viaAlias.layout.workspace).toBe(viaRoot.layout.workspace);
      expect(viaAlias.layout.dir).toBe(viaRoot.layout.dir);
      expect(viaAlias.layout.spec).toBe(viaRoot.layout.spec);
      expect(viaAlias.layout.plan).toBe(viaRoot.layout.plan);
    }
  } finally {
    cleanup(root);
    cleanup(aliasRoot);
  }
});

test("prepare detects read-only legacy state without touching it", () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, ".superpowers", "sdd"), { recursive: true });
    mkdirSync(path.join(root, "docs", "superpowers"), { recursive: true });
    writeFileSync(path.join(root, "docs", "superpowers", "spec.md"), "legacy bytes", "utf8");
    const res = prepareDocsLayout({ workspace_root: root, slug });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.legacy.legacy_sdd).toBe(true);
    expect(res.legacy.superpowers_dir).toBe(true);
    expect(readFileSync(path.join(root, "docs", "superpowers", "spec.md"), "utf8")).toBe(
      "legacy bytes",
    );
  } finally {
    cleanup(root);
  }
});

test("probeLegacyDocs reports legacy without any prepare side effects", () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, ".superpowers", "sdd"), { recursive: true });
    const probe = probeLegacyDocs(root);
    expect(probe).toEqual({ legacy_sdd: true, superpowers_dir: false });
    expect(existsSync(path.join(root, "docs"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("workflow_docs_layout prepare registers on the opencode adapter and prepares a fresh slug", async () => {
  const root = tmp();
  try {
    const tools = createDocsRepoTools();
    expect(typeof tools.workflow_docs_layout).toBe("object");
    const raw = await tools.workflow_docs_layout.execute({ slug }, {
      directory: root,
      worktree: root,
    } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", slug))).toBe(true);
    expect(existsSync(path.join(root, "docs", slug, "sdd"))).toBe(false);
    if (out.ok) {
      expect(posix(out.data.layout.dir)).toBe(posix(realpathSync(path.join(root, "docs", slug))));
      expect(out.data.created.sort()).toEqual(["docs", `docs/${slug}`]);
    }
  } finally {
    cleanup(root);
  }
});

test("workflow_docs_layout prepare rejects traversal through the opencode adapter", async () => {
  const root = tmp();
  try {
    const tools = createDocsRepoTools();
    const raw = await tools.workflow_docs_layout.execute({ plan_path: "../outside.md" }, {
      directory: root,
      worktree: root,
    } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});
