import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Bounded legacy detection and atomic copy-only migration (DC-05-DC-11). The
// legacy root `docs/superpowers/` is reserved (Task 16): it is never written
// through the canonical layout, and migration is the only bounded path that
// reads it. Migration copies byte-identical sources, never deletes or edits
// them, never overwrites a differing destination, and rewrites plan links /
// valid flow paths only inside the files it copies.

export const LEGACY_DIR = "docs/superpowers";

// Exact native question choices (DC-07): both host adapters surface these
// verbatim through their native question / AskQuestion flow.
export const MIGRATION_CHOICES = ["Migrate safely", "Not now"] as const;

export type LegacyEntry = {
  /** Proposed canonical slug; "" when none can be derived. */
  slug: string;
  /** Relative legacy dir, e.g. docs/superpowers/foo. */
  legacy_dir: string;
  /** Relative legacy spec.md path when present. */
  spec: string | null;
  /** Relative legacy plan.md path when present. */
  plan: string | null;
  /** Legacy docs/superpowers/<name>/sdd exists. */
  sdd: boolean;
  /** spec + plan both present. */
  paired: boolean;
  /** Paired through an explicit plan **Spec:** link. */
  explicit: boolean;
  status: "paired" | "orphan" | "ambiguous";
};

export type DetectResult = {
  legacy_dir: string;
  entries: LegacyEntry[];
  paired: LegacyEntry[];
  orphaned: LegacyEntry[];
  ambiguous: LegacyEntry[];
  /** No ambiguity or collision — preflight is safe to migrate. */
  safe: boolean;
};

export type MigrationQuestion = {
  prompt: string;
  options: readonly ["Migrate safely", "Not now"];
};

export type MigrateItem = {
  kind: "spec" | "plan" | "sdd";
  from: string;
  to: string;
  status: "copied" | "rewritten" | "already_migrated" | "malformed";
};

export type MigrateReport = {
  legacy_dir: string;
  copied: string[];
  rewritten: string[];
  already_migrated: string[];
  malformed: string[];
  collisions: string[];
  items: MigrateItem[];
};

export type MigrateResult =
  | { ok: true; declined: false; data: MigrateReport }
  | {
      ok: false;
      declined: boolean;
      active_workflow: boolean;
      error: string;
      collisions?: string[];
    };

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_SLUG = "superpowers";
const SPEC_LINK_RE = /^\s*\*+Spec:\*+\s*(?:`([^`]+)`|(\S+))\s*$/im;

const posix = (p: string) => p.split(path.sep).join("/");

const legacyRoot = (workspace: string) => path.join(workspace, "docs", "superpowers");

const readFileSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// The canonical `docs/<slug>/sdd/` ignore contract (DC-10): SDD state is only
// copied once the working-state dir is gitignored. Not a git repo means the
// contract is not active — refuse rather than guess.
const sddIgnoreActive = (cwd: string, slug: string): boolean => {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
  } catch {
    return false;
  }
  try {
    execFileSync(
      "git",
      ["-C", cwd, "check-ignore", path.posix.join("docs", slug, "sdd", "progress.md")],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
};

const explicitTargetSlug = (planText: string | null): string | null => {
  if (planText === null) return null;
  const match = planText.match(SPEC_LINK_RE);
  if (!match) return null;
  const link = (match[1] ?? match[2] ?? "").trim();
  const m = link.match(/^docs\/([^/]+)\/spec\.md$/);
  if (!m) return null;
  const candidate = m[1];
  if (candidate === RESERVED_SLUG || !SLUG_RE.test(candidate)) return null;
  return candidate;
};

/**
 * Read-only bounded preflight (DC-05, DC-06): scans only `docs/superpowers/`
 * one level deep, pairs via explicit plan links first then filename fallback,
 * and reports orphaned and ambiguous items. Never mutates anything.
 */
export const detectLegacyDocs = (workspace_root: string): DetectResult => {
  const root = legacyRoot(workspace_root);
  const raw: Array<{
    slug: string;
    legacy_dir: string;
    spec: string | null;
    plan: string | null;
    sdd: boolean;
    explicit: boolean;
  }> = [];

  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const abs = path.join(root, entry.name);
      const rel = posix(path.relative(workspace_root, abs));
      if (entry.isDirectory()) {
        const hasSpec = existsSync(path.join(abs, "spec.md"));
        const hasPlan = existsSync(path.join(abs, "plan.md"));
        if (!hasSpec && !hasPlan && !existsSync(path.join(abs, "sdd"))) continue;
        const explicit = explicitTargetSlug(
          hasPlan ? readFileSafe(path.join(abs, "plan.md")) : null,
        );
        raw.push({
          slug: explicit ?? entry.name,
          legacy_dir: rel,
          spec: hasSpec ? posix(path.join(rel, "spec.md")) : null,
          plan: hasPlan ? posix(path.join(rel, "plan.md")) : null,
          sdd: existsSync(path.join(abs, "sdd")),
          explicit: explicit !== null,
        });
      } else if (entry.name === "spec.md" || entry.name === "plan.md") {
        // Top-level docs/superpowers/(spec|plan).md has no derivable slug.
        raw.push({
          slug: "",
          legacy_dir: LEGACY_DIR,
          spec: entry.name === "spec.md" ? rel : null,
          plan: entry.name === "plan.md" ? rel : null,
          sdd: false,
          explicit: false,
        });
      }
    }
  }

  // Colliding target slugs are ambiguous: two legacy dirs mapping to the same
  // canonical slug cannot be merged safely.
  const groupKey = (slug: string) => (slug === "" ? "\u0000" : slug);
  const bySlug = new Map<string, number>();
  for (const r of raw) bySlug.set(groupKey(r.slug), (bySlug.get(groupKey(r.slug)) ?? 0) + 1);

  const entries: LegacyEntry[] = [];
  for (const r of raw) {
    const collided =
      (bySlug.get(groupKey(r.slug)) ?? 0) > 1 ||
      r.slug === RESERVED_SLUG ||
      (r.slug !== "" && !SLUG_RE.test(r.slug));
    const hasSpec = r.spec !== null;
    const hasPlan = r.plan !== null;
    let status: LegacyEntry["status"];
    if (hasSpec && hasPlan) {
      status = collided || r.slug === "" ? "ambiguous" : "paired";
    } else if (hasSpec || hasPlan || r.sdd) {
      status = collided || r.slug === "" ? "ambiguous" : "orphan";
    } else {
      continue;
    }
    entries.push({
      ...r,
      paired: hasSpec && hasPlan,
      status,
    });
  }

  const paired = entries.filter((e) => e.status === "paired");
  const orphaned = entries.filter((e) => e.status === "orphan");
  const ambiguous = entries.filter((e) => e.status === "ambiguous");
  return {
    legacy_dir: LEGACY_DIR,
    entries,
    paired,
    orphaned,
    ambiguous,
    safe: ambiguous.length === 0,
  };
};

export const migrationQuestion = (detect: DetectResult): MigrationQuestion => {
  const count = detect.paired.length;
  return {
    prompt:
      count === 0
        ? "No legacy workflows found under docs/superpowers/."
        : `Legacy workflows found under docs/superpowers/ (${count} safe to migrate). Copy them to docs/<slug>/ without touching the originals?`,
    options: MIGRATION_CHOICES,
  };
};

type PlannedCopy = {
  kind: "spec" | "plan" | "sdd";
  legacyName: string;
  slug: string;
  fromAbs: string;
  fromRel: string;
  toRel: string;
  destAbs: string;
  /** Exact bytes that will be written (already rewritten when applicable). */
  bytes: Buffer;
  status: MigrateItem["status"];
};

// Rewrite references from this entry's legacy paths to the canonical slug. The
// scope is bounded to the copied file's own workflow name (DC-09): other
// workflows' legacy paths are left untouched.
const rewriteLegacyReferences = (text: string, legacyName: string, slug: string): string =>
  text.split(`docs/superpowers/${legacyName}`).join(`docs/${slug}`);

// Valid JSON flow paths may be rewritten; invalid flow state is preserved
// byte-for-byte and reported as malformed (DC-09).
const flowRewrite = (
  text: string,
  legacyName: string,
  slug: string,
): { ok: boolean; out: string; changed: boolean } => {
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, out: text, changed: false };
  }
  const out = rewriteLegacyReferences(text, legacyName, slug);
  return { ok: true, out, changed: out !== text };
};

const isPlanMalformed = (text: string): boolean => !/^\s*\*+Spec:\*+/im.test(text);

const readBufferSafe = (p: string): Buffer | null => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

// Compute the exact destination bytes and item status for a spec/plan copy.
const classifyDoc = (
  kind: "spec" | "plan",
  legacyName: string,
  slug: string,
  fromAbs: string,
): { ok: true; bytes: Buffer; status: MigrateItem["status"] } | { ok: false; error: string } => {
  const raw = readBufferSafe(fromAbs);
  if (raw === null) return { ok: false, error: `unreadable source ${fromAbs}` };
  if (kind === "spec") return { ok: true, bytes: raw, status: "copied" };
  const text = raw.toString("utf8");
  if (isPlanMalformed(text)) return { ok: true, bytes: raw, status: "malformed" };
  const next = rewriteLegacyReferences(text, legacyName, slug);
  return {
    ok: true,
    bytes: Buffer.from(next, "utf8"),
    status: next === text ? "copied" : "rewritten",
  };
};

const classifySdd = (
  legacyName: string,
  slug: string,
  fromAbs: string,
  toRel: string,
): { ok: true; bytes: Buffer; status: MigrateItem["status"] } | { ok: false; error: string } => {
  const raw = readBufferSafe(fromAbs);
  if (raw === null) return { ok: false, error: `unreadable source ${fromAbs}` };
  if (path.basename(toRel) !== "flow.json") return { ok: true, bytes: raw, status: "copied" };
  const flow = flowRewrite(raw.toString("utf8"), legacyName, slug);
  if (!flow.ok) return { ok: true, bytes: raw, status: "malformed" };
  return {
    ok: true,
    bytes: Buffer.from(flow.out, "utf8"),
    status: flow.changed ? "rewritten" : "copied",
  };
};

// Walk a source tree (files and symlinks) producing planned file copies.
// Symlinks are resolved: escaping the workspace aborts the whole migration
// atomically; in-workspace targets are copied as regular file content.
const planTree = (
  workspace: string,
  legacyAbs: string,
  legacyRel: string,
  destRelRoot: string,
  legacyName: string,
  slug: string,
  plan: PlannedCopy[],
  visits: Set<string>,
): { ok: true } | { ok: false; error: string } => {
  const real = realpathSync(legacyAbs);
  if (real !== workspace && !real.startsWith(workspace + path.sep)) {
    return { ok: false, error: `symlink escape refused: ${legacyRel}` };
  }
  if (visits.has(real)) return { ok: true };
  visits.add(real);
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    const fromAbs = path.join(real, entry.name);
    const fromRel = posix(path.join(legacyRel, entry.name));
    const toRel = posix(path.join(destRelRoot, entry.name));
    if (entry.isDirectory()) {
      const sub = planTree(workspace, fromAbs, fromRel, toRel, legacyName, slug, plan, visits);
      if (!sub.ok) return sub;
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      let targetAbs = fromAbs;
      if (entry.isSymbolicLink()) {
        const target = realpathSync(fromAbs);
        if (target !== workspace && !target.startsWith(workspace + path.sep)) {
          return { ok: false, error: `symlink escape refused: ${fromRel}` };
        }
        if (statSync(target).isDirectory()) {
          const sub = planTree(workspace, fromAbs, fromRel, toRel, legacyName, slug, plan, visits);
          if (!sub.ok) return sub;
          continue;
        }
        targetAbs = target;
      }
      const classified = classifySdd(legacyName, slug, targetAbs, toRel);
      if (!classified.ok) return classified;
      plan.push({
        kind: "sdd",
        legacyName,
        slug,
        fromAbs,
        fromRel,
        toRel,
        destAbs: path.join(workspace, toRel),
        bytes: classified.bytes,
        status: classified.status,
      });
    }
  }
  return { ok: true };
};

const planEntry = (
  workspace: string,
  entry: LegacyEntry,
  plan: PlannedCopy[],
  visits: Set<string>,
): { ok: true } | { ok: false; error: string } => {
  const legacyName = entry.legacy_dir.slice(LEGACY_DIR.length + 1);
  const base = (kind: "spec" | "plan") => ({
    kind,
    legacyName,
    slug: entry.slug,
    toRel: posix(path.join("docs", entry.slug, `${kind}.md`)),
    destAbs: path.join(workspace, "docs", entry.slug, `${kind}.md`),
  });
  if (entry.spec) {
    const classified = classifyDoc(
      "spec",
      legacyName,
      entry.slug,
      path.join(workspace, entry.spec),
    );
    if (!classified.ok) return classified;
    plan.push({
      ...base("spec"),
      fromAbs: path.join(workspace, entry.spec),
      fromRel: entry.spec,
      bytes: classified.bytes,
      status: classified.status,
    });
  }
  if (entry.plan) {
    const classified = classifyDoc(
      "plan",
      legacyName,
      entry.slug,
      path.join(workspace, entry.plan),
    );
    if (!classified.ok) return classified;
    plan.push({
      ...base("plan"),
      fromAbs: path.join(workspace, entry.plan),
      fromRel: entry.plan,
      bytes: classified.bytes,
      status: classified.status,
    });
  }
  if (entry.sdd) {
    const legacySdd = posix(path.join(entry.legacy_dir, "sdd"));
    return planTree(
      workspace,
      path.join(workspace, legacySdd),
      legacySdd,
      posix(path.join("docs", entry.slug, "sdd")),
      legacyName,
      entry.slug,
      plan,
      visits,
    );
  }
  return { ok: true };
};

const abort = (error: string, collisions?: string[]): MigrateResult => ({
  ok: false,
  declined: false,
  active_workflow: false,
  error,
  ...(collisions ? { collisions } : {}),
});

const declined = (active_workflow: boolean): MigrateResult => ({
  ok: false,
  declined: true,
  active_workflow,
  error: "legacy migration declined",
});

/**
 * Copy-only migration (DC-08, DC-09, DC-10). Requires confirmed preflight
 * identity: every run rescans legacy state, never writes without confirmation,
 * aborts atomically on differing destinations, never overwrites identical or
 * differing targets, and preserves sources byte-identical. When migration of
 * the active workflow is declined, canonical authoring must stop (DC-11) — the
 * caller reads `active_workflow` and halts.
 */
export const migrateLegacyDocs = (input: {
  workspace_root: string;
  slug?: string;
  confirmed: boolean;
}): MigrateResult => {
  const { workspace_root, slug, confirmed } = input;
  const detect = detectLegacyDocs(workspace_root);

  if (confirmed !== true) {
    const active = Boolean(slug && detect.paired.some((e) => e.slug === slug));
    return declined(active);
  }

  if (!detect.safe) {
    const names = detect.ambiguous.map((e) => e.legacy_dir).join(", ");
    return abort(
      `legacy migration aborted: ambiguous legacy entries (${names}); resolve before migrating`,
    );
  }

  // SDD ignore gate (DC-10): refuse SDD copying until the canonical sdd dir is
  // gitignored. This also guards against creating a docs-only divergent copy of
  // an active legacy workflow (CA-17).
  for (const entry of detect.paired) {
    if (entry.sdd && !sddIgnoreActive(workspace_root, entry.slug)) {
      return abort(
        `legacy migration refused: docs/${entry.slug}/sdd/ is not gitignored (add 'docs/*/sdd/' to .gitignore) so active SDD state cannot be copied safely`,
      );
    }
  }

  const plan: PlannedCopy[] = [];
  const visits = new Set<string>();
  for (const entry of detect.paired) {
    const planned = planEntry(workspace_root, entry, plan, visits);
    if (!planned.ok) return abort(planned.error);
  }

  // Preflight classification (no writes yet): differing destinations abort the
  // whole migration atomically; destinations matching the exact bytes that
  // would be written are already migrated (idempotent retries stay green).
  const collisions: string[] = [];
  for (const item of plan) {
    if (!existsSync(item.destAbs)) continue;
    if (lstatSync(item.destAbs).isDirectory() || !readFileSync(item.destAbs).equals(item.bytes)) {
      collisions.push(item.toRel);
    } else {
      item.status = "already_migrated";
    }
  }
  if (collisions.length > 0) {
    return abort(
      `legacy migration aborted: collision on differing destinations (${collisions.join(", ")}); no files were written`,
      collisions,
    );
  }

  // Execute staged copies: write to a temp sibling then rename so a partial
  // failure never leaves a torn destination, and a retry stays idempotent.
  const report: MigrateReport = {
    legacy_dir: LEGACY_DIR,
    copied: [],
    rewritten: [],
    already_migrated: [],
    malformed: [],
    collisions: [],
    items: [],
  };

  for (const item of plan) {
    if (item.status === "already_migrated") {
      report.already_migrated.push(item.toRel);
      report.items.push({
        kind: item.kind,
        from: item.fromRel,
        to: item.toRel,
        status: "already_migrated",
      });
      continue;
    }
    const tmp = `${item.destAbs}.workit-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      mkdirSync(path.dirname(item.destAbs), { recursive: true });
      writeFileSync(tmp, item.bytes);
      renameSync(tmp, item.destAbs);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      return abort(
        `legacy migration retry required: failed to copy ${item.fromRel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (item.status === "malformed") report.malformed.push(item.toRel);
    else if (item.status === "rewritten") report.rewritten.push(item.toRel);
    else report.copied.push(item.toRel);
    report.items.push({ kind: item.kind, from: item.fromRel, to: item.toRel, status: item.status });
  }

  return { ok: true, declined: false, data: report };
};
