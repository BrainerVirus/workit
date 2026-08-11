import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  detectLegacyDocs,
  migrateLegacyDocs,
  MIGRATION_CHOICES,
} from "../../packages/workit-core/src/core/docs-migration";

const posix = (p: string) => p.split(path.sep).join("/");

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wf-migrate-"));
const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const legacySpec = (name: string) => `# Spec ${name}\n\n**Branch:** \`feature/${name}\`\n`;

const legacyPlan = (name: string, opts: { specLink?: string; noSpecLink?: boolean } = {}) => {
  if (opts.noSpecLink) {
    return `# Plan ${name}\n\n**Branch:** \`feature/${name}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`;
  }
  const link = opts.specLink === undefined ? `docs/superpowers/${name}/spec.md` : opts.specLink;
  return `# Plan ${name}\n\n**Spec:** \`${link}\`\n**Branch:** \`feature/${name}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`;
};

const legacyFlow = (name: string) =>
  JSON.stringify({
    spec: `docs/superpowers/${name}/spec.md`,
    plan: `docs/superpowers/${name}/plan.md`,
    sdd: `docs/superpowers/${name}/sdd`,
  });

const putLegacy = (
  root: string,
  name: string,
  opts: {
    spec?: boolean;
    plan?: boolean;
    specText?: string;
    planText?: string;
    sdd?: boolean;
    flow?: boolean;
    extra?: Record<string, string>;
  } = {},
) => {
  const dir = path.join(root, "docs", "superpowers", name);
  mkdirSync(dir, { recursive: true });
  if (opts.spec !== false)
    writeFileSync(path.join(dir, "spec.md"), opts.specText ?? legacySpec(name), "utf8");
  if (opts.plan !== false)
    writeFileSync(path.join(dir, "plan.md"), opts.planText ?? legacyPlan(name), "utf8");
  if (opts.sdd) {
    mkdirSync(path.join(dir, "sdd"), { recursive: true });
    writeFileSync(path.join(dir, "sdd", "progress.md"), "Task 1: complete\n", "utf8");
    if (opts.flow) writeFileSync(path.join(dir, "sdd", "flow.json"), legacyFlow(name), "utf8");
  }
  for (const [rel, text] of Object.entries(opts.extra ?? {})) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
};

type Snapshot = Record<string, { type: string; body?: string; link?: string }>;
const snapshotSources = (root: string): Snapshot => {
  const out: Snapshot = {};
  const walk = (dir: string, base: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = posix(path.join(base, entry.name));
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out[rel] = { type: "link", link: readlinkSync(abs) };
      else if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = { type: "file", body: readFileSync(abs, "utf8") };
    }
  };
  walk(path.join(root, "docs", "superpowers"), "docs/superpowers");
  return out;
};

const gitRepo = (root: string) => {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "T"]);
};

test("MIGRATION_CHOICES are exactly Migrate safely and Not now", () => {
  expect([...MIGRATION_CHOICES]).toEqual(["Migrate safely", "Not now"]);
});

test("detect pairs through explicit plan links first", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo", {
      spec: true,
      plan: true,
      planText: legacyPlan("foo", { specLink: "docs/bar/spec.md" }),
    });
    const detect = detectLegacyDocs(root);
    expect(detect.safe).toBe(true);
    expect(detect.paired.length).toBe(1);
    const entry = detect.paired[0];
    expect(entry.legacy_dir).toBe("docs/superpowers/foo");
    expect(entry.slug).toBe("bar");
    expect(entry.explicit).toBe(true);
    expect(entry.status).toBe("paired");
  } finally {
    cleanup(root);
  }
});

test("detect pairs through filename fallback when no explicit link", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    const detect = detectLegacyDocs(root);
    const entry = detect.paired[0];
    expect(entry.slug).toBe("foo");
    expect(entry.explicit).toBe(false);
    expect(detect.paired.length).toBe(1);
    expect(detect.ambiguous.length).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("detect scans only docs/superpowers and flags top-level files as ambiguous", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    writeFileSync(path.join(root, "docs", "superpowers", "spec.md"), "# top\n", "utf8");
    mkdirSync(path.join(root, "docs", "other"), { recursive: true });
    writeFileSync(path.join(root, "docs", "other", "spec.md"), "# other\n", "utf8");
    const detect = detectLegacyDocs(root);
    expect(detect.legacy_dir).toBe("docs/superpowers");
    expect(detect.paired.some((e) => e.slug === "foo")).toBe(true);
    expect(detect.paired.some((e) => e.slug === "other")).toBe(false);
    const topLevel = detect.ambiguous.find((e) => e.legacy_dir === "docs/superpowers");
    expect(topLevel).toBeDefined();
    if (topLevel) {
      expect(topLevel.slug).toBe("");
      expect(topLevel.spec).toBe("docs/superpowers/spec.md");
    }
    expect(detect.safe).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("detect reports orphaned spec-only, plan-only, and sdd-only entries", () => {
  const root = tmp();
  try {
    putLegacy(root, "spec-only", { plan: false });
    putLegacy(root, "plan-only", { spec: false });
    putLegacy(root, "sdd-only", { spec: false, plan: false, sdd: true });
    const detect = detectLegacyDocs(root);
    expect(detect.orphaned.length).toBe(3);
    expect(detect.orphaned.every((e) => e.paired === false)).toBe(true);
    expect(detect.paired.length).toBe(0);
    expect(detect.safe).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("detect marks colliding target slugs ambiguous and unsafe", () => {
  const root = tmp();
  try {
    putLegacy(root, "a", { planText: legacyPlan("a", { specLink: "docs/x/spec.md" }) });
    putLegacy(root, "b", { planText: legacyPlan("b", { specLink: "docs/x/spec.md" }) });
    const detect = detectLegacyDocs(root);
    expect(detect.ambiguous.length).toBe(2);
    expect(detect.safe).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("migrate without confirmation declines, writes nothing, and flags the active workflow", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo", { sdd: true });
    const before = snapshotSources(root);
    const declined = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: false });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.declined).toBe(true);
      expect(declined.active_workflow).toBe(true);
    }
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
    expect(snapshotSources(root)).toEqual(before);
  } finally {
    cleanup(root);
  }
});

test("migrate decline for an unrelated slug is not an active-workflow block", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo", { sdd: true });
    const declined = migrateLegacyDocs({ workspace_root: root, slug: "other", confirmed: false });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.declined).toBe(true);
      expect(declined.active_workflow).toBe(false);
    }
  } finally {
    cleanup(root);
  }
});

test("confirmed migrate rescans legacy state added after an earlier call", () => {
  const root = tmp();
  try {
    expect(detectLegacyDocs(root).entries.length).toBe(0);
    const declined = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: false });
    expect(declined.ok).toBe(false);
    putLegacy(root, "foo");
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.copied).toContain("docs/foo/spec.md");
  } finally {
    cleanup(root);
  }
});

test("migrate aborts atomically on differing destinations with no partial copy", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    mkdirSync(path.join(root, "docs", "foo"), { recursive: true });
    writeFileSync(path.join(root, "docs", "foo", "spec.md"), "DIFFERENT\n", "utf8");
    const before = snapshotSources(root);
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.collisions ?? []).toContain("docs/foo/spec.md");
      expect(result.error).toMatch(/collision/i);
    }
    expect(existsSync(path.join(root, "docs", "foo", "plan.md"))).toBe(false);
    expect(snapshotSources(root)).toEqual(before);
  } finally {
    cleanup(root);
  }
});

test("migrate treats identical destinations as already migrated and is idempotent", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    mkdirSync(path.join(root, "docs", "foo"), { recursive: true });
    // a prior successful migration left the rewritten canonical content behind
    writeFileSync(path.join(root, "docs", "foo", "spec.md"), legacySpec("foo"), "utf8");
    writeFileSync(
      path.join(root, "docs", "foo", "plan.md"),
      legacyPlan("foo", { specLink: "docs/foo/spec.md" }),
      "utf8",
    );
    const first = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.already_migrated).toContain("docs/foo/spec.md");
      expect(first.data.already_migrated).toContain("docs/foo/plan.md");
      expect(first.data.copied.length).toBe(0);
      expect(first.data.collisions.length).toBe(0);
    }
    const second = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.already_migrated).toContain("docs/foo/spec.md");
  } finally {
    cleanup(root);
  }
});

test("migrate treats a destination symlink to a directory as a collision, not a throw (D4)", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    mkdirSync(path.join(root, "docs", "foo"), { recursive: true });
    const target = tmp();
    symlinkSync(target, path.join(root, "docs", "foo", "spec.md"));
    try {
      const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.collisions ?? []).toContain("docs/foo/spec.md");
        expect(result.error).toMatch(/collision/i);
      }
      expect(existsSync(path.join(root, "docs", "foo", "plan.md"))).toBe(false);
    } finally {
      cleanup(target);
    }
  } finally {
    cleanup(root);
  }
});

test("migrate copies a paired workflow and preserves sources byte-identical", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    writeFileSync(path.join(root, "docs", "superpowers", "foo", "notes.md"), "stray\n", "utf8");
    const before = snapshotSources(root);
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.copied).toContain("docs/foo/spec.md");
      expect(result.data.rewritten).toContain("docs/foo/plan.md");
      expect(result.data.copied).not.toContain("docs/foo/notes.md");
      expect(result.data.malformed.length).toBe(0);
    }
    expect(existsSync(path.join(root, "docs", "foo", "notes.md"))).toBe(false);
    expect(snapshotSources(root)).toEqual(before);
  } finally {
    cleanup(root);
  }
});

test("migrate copies symlinked file content and refuses symlink escapes atomically", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    const outside = tmp();
    writeFileSync(path.join(outside, "secret.md"), "outside bytes\n", "utf8");
    try {
      putLegacy(root, "foo", { sdd: true });
      writeFileSync(path.join(root, "shared.md"), "shared bytes\n", "utf8");
      symlinkSync(
        path.join("..", "..", "..", "..", "shared.md"),
        path.join(root, "docs", "superpowers", "foo", "sdd", "link.md"),
      );
      symlinkSync(
        path.join(outside, "secret.md"),
        path.join(root, "docs", "superpowers", "foo", "sdd", "evil.md"),
      );
      const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/symlink|escape/i);
      expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
    } finally {
      cleanup(outside);
    }
  } finally {
    cleanup(root);
  }
});

test("migrate copies a symlinked source as regular content bytes", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "foo", { sdd: true });
    writeFileSync(path.join(root, "shared.md"), "shared bytes\n", "utf8");
    symlinkSync(
      path.join("..", "..", "..", "..", "shared.md"),
      path.join(root, "docs", "superpowers", "foo", "sdd", "link.md"),
    );
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.copied).toContain("docs/foo/sdd/link.md");
    }
    const dest = path.join(root, "docs", "foo", "sdd", "link.md");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("shared bytes\n");
    expect(readlinkSync(path.join(root, "docs", "superpowers", "foo", "sdd", "link.md"))).toBe(
      path.join("..", "..", "..", "..", "shared.md"),
    );
  } finally {
    cleanup(root);
  }
});

test("migrate retries safely after a partial copy failure", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "foo", { sdd: true });
    mkdirSync(path.join(root, "docs", "foo"), { recursive: true });
    writeFileSync(path.join(root, "docs", "foo", "sdd"), "blocking file", "utf8");
    const first = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toMatch(/retry|copy|directory/i);
    const temps = readdirSync(path.join(root, "docs", "foo")).filter((n) =>
      n.includes("workit-tmp"),
    );
    expect(temps).toEqual([]);
    expect(readFileSync(path.join(root, "docs", "foo", "spec.md"), "utf8")).toBe(legacySpec("foo"));
    rmSync(path.join(root, "docs", "foo", "sdd"), { force: true });
    const second = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.already_migrated).toContain("docs/foo/spec.md");
      expect(second.data.already_migrated).toContain("docs/foo/plan.md");
      expect(second.data.copied).toContain("docs/foo/sdd/progress.md");
    }
    expect(readFileSync(path.join(root, "docs", "foo", "sdd", "progress.md"), "utf8")).toBe(
      "Task 1: complete\n",
    );
  } finally {
    cleanup(root);
  }
});

test("migrate rewrites copied plan links and flow paths to canonical locations only", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "foo", { sdd: true, flow: true });
    mkdirSync(path.join(root, "docs", "unrelated"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "unrelated", "spec.md"),
      "# Spec unrelated\n\nlinks to `docs/superpowers/unrelated/spec.md`\n",
      "utf8",
    );
    const before = snapshotSources(root);
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rewritten).toContain("docs/foo/plan.md");
      expect(result.data.rewritten).toContain("docs/foo/sdd/flow.json");
    }
    const planText = readFileSync(path.join(root, "docs", "foo", "plan.md"), "utf8");
    expect(planText).toContain("**Spec:** `docs/foo/spec.md`");
    expect(planText).not.toContain("docs/superpowers/foo");
    const flowText = readFileSync(path.join(root, "docs", "foo", "sdd", "flow.json"), "utf8");
    expect(flowText).toContain("docs/foo/spec.md");
    expect(flowText).toContain("docs/foo/plan.md");
    expect(flowText).toContain("docs/foo/sdd");
    expect(flowText).not.toContain("docs/superpowers/foo");
    // a canonical file outside the copied set is never rewritten
    const untouched = readFileSync(path.join(root, "docs", "unrelated", "spec.md"), "utf8");
    expect(untouched).toContain("docs/superpowers/unrelated/spec.md");
    expect(snapshotSources(root)).toEqual(before);
  } finally {
    cleanup(root);
  }
});

test("migrate preserves malformed plan and flow state byte-identical and reports it", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    const malformedPlan = "# Plan foo\n\n**Branch:** `feature/foo`\n\n### Task 1: One\n";
    putLegacy(root, "foo", {
      sdd: true,
      planText: malformedPlan,
      flow: false,
    });
    writeFileSync(
      path.join(root, "docs", "superpowers", "foo", "sdd", "flow.json"),
      "{not valid json\n",
      "utf8",
    );
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.malformed).toContain("docs/foo/plan.md");
      expect(result.data.malformed).toContain("docs/foo/sdd/flow.json");
      expect(result.data.rewritten).toEqual([]);
    }
    expect(readFileSync(path.join(root, "docs", "foo", "plan.md"), "utf8")).toBe(malformedPlan);
    expect(readFileSync(path.join(root, "docs", "foo", "sdd", "flow.json"), "utf8")).toBe(
      "{not valid json\n",
    );
  } finally {
    cleanup(root);
  }
});

test("migrate refuses SDD copy until the canonical SDD ignore contract is active", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo", { sdd: true, flow: true });
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sdd|gitignore|ignore/i);
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("migrate copies SDD state when docs/*/sdd is gitignored", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "foo", { sdd: true, flow: true });
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.copied).toContain("docs/foo/sdd/progress.md");
      expect(result.data.rewritten).toContain("docs/foo/sdd/flow.json");
    }
    expect(readFileSync(path.join(root, "docs", "foo", "sdd", "progress.md"), "utf8")).toBe(
      "Task 1: complete\n",
    );
  } finally {
    cleanup(root);
  }
});

test("migrate copies both workflows sharing a symlinked sdd dir (per-entry visits)", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "a", { sdd: true });
    putLegacy(root, "b", { sdd: false });
    symlinkSync(path.join("..", "a", "sdd"), path.join(root, "docs", "superpowers", "b", "sdd"));
    const result = migrateLegacyDocs({ workspace_root: root, slug: "a", confirmed: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.copied).toContain("docs/a/sdd/progress.md");
      expect(result.data.copied).toContain("docs/b/sdd/progress.md");
    }
    expect(readFileSync(path.join(root, "docs", "b", "sdd", "progress.md"), "utf8")).toBe(
      "Task 1: complete\n",
    );
  } finally {
    cleanup(root);
  }
});

test("migrate refuses a docs/<slug> symlink escaping the workspace and writes nothing outside", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo");
    const outside = tmp();
    try {
      mkdirSync(path.join(root, "docs"), { recursive: true });
      symlinkSync(outside, path.join(root, "docs", "foo"));
      const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/escape|stay inside|inside repository/i);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      cleanup(outside);
    }
  } finally {
    cleanup(root);
  }
});

test("migrate does not rewrite sibling-name-prefix legacy references", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "flow", { sdd: true, flow: true });
    const planText = readFileSync(
      path.join(root, "docs", "superpowers", "flow", "plan.md"),
      "utf8",
    );
    const prefixed = `${planText}\n\n**See also:** \`docs/superpowers/flowchart/plan.md\`\n`;
    writeFileSync(path.join(root, "docs", "superpowers", "flow", "plan.md"), prefixed, "utf8");
    const result = migrateLegacyDocs({ workspace_root: root, slug: "flow", confirmed: true });
    expect(result.ok).toBe(true);
    const copiedPlan = readFileSync(path.join(root, "docs", "flow", "plan.md"), "utf8");
    expect(copiedPlan).toContain("**Spec:** `docs/flow/spec.md`");
    expect(copiedPlan).toContain("docs/superpowers/flowchart/plan.md");
    expect(copiedPlan).not.toContain("docs/flowchart/plan.md");
  } finally {
    cleanup(root);
  }
});

test("migrate aborts cleanly on a dangling symlink instead of throwing", () => {
  const root = tmp();
  try {
    gitRepo(root);
    writeFileSync(path.join(root, ".gitignore"), "docs/*/sdd/\n", "utf8");
    putLegacy(root, "foo", { sdd: true });
    symlinkSync(
      path.join("missing-target"),
      path.join(root, "docs", "superpowers", "foo", "sdd", "dangling.md"),
    );
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dangling|symlink|realpath/i);
  } finally {
    cleanup(root);
  }
});

test("migrate cannot create a divergent active workflow when SDD copy is refused", () => {
  const root = tmp();
  try {
    putLegacy(root, "foo", { sdd: true, flow: true });
    const result = migrateLegacyDocs({ workspace_root: root, slug: "foo", confirmed: true });
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(root, "docs", "foo"))).toBe(false);
    expect(existsSync(path.join(root, "docs", "foo", "spec.md"))).toBe(false);
  } finally {
    cleanup(root);
  }
});
