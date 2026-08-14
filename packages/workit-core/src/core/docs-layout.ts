import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// One canonical document path contract (DC-01, DC-02, DC-04, DC-14): workspace
// root, slug, and spec/plan pair resolution all funnel through here so every
// document/flow/SDD consumer on both hosts enforces the same containment rules.

export type CanonicalLayout = {
  /** Canonical (realpath) workspace root. */
  workspace: string;
  /** Validated slug. */
  slug: string;
  /** Canonical path of docs/. */
  docs: string;
  /** Canonical path of docs/<slug>/. */
  dir: string;
  /** Canonical path of docs/<slug>/spec.md. */
  spec: string;
  /** Canonical path of docs/<slug>/plan.md. */
  plan: string;
  /** Canonical path of docs/<slug>/sdd/. */
  sdd: string;
};

export type LayoutResult = { ok: true; layout: CanonicalLayout } | { ok: false; error: string };

export type LegacyProbe = {
  /** `.superpowers/sdd` exists. */
  legacy_sdd: boolean;
  /** `docs/superpowers/` exists. */
  superpowers_dir: boolean;
};

export type PrepareResult =
  | { ok: true; layout: CanonicalLayout; created: string[]; legacy: LegacyProbe }
  | { ok: false; error: string };

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reserved legacy root (DC-05): never resolve or prepare a slug under it. */
const LEGACY_SLUG = "superpowers";

const posix = (p: string) => p.split(path.sep).join("/");

// Realpath the nearest existing ancestor of `candidate` and reject the result
// when it escapes `base` (base must already be canonical). The returned path is
// canonical where it exists and joined for the non-existent tail.
const canonicalize = (base: string, candidate: string): string => {
  const abs = path.resolve(base, candidate);
  let ancestor = abs;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = realpathSync(ancestor);
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error(`path must stay inside repository root: ${candidate}`);
  }
  return path.join(real, path.relative(ancestor, abs));
};

const buildLayout = (workspace: string, slug: string): CanonicalLayout => {
  const docs = canonicalize(workspace, "docs");
  const dir = canonicalize(workspace, path.join(docs, slug));
  return {
    workspace,
    slug,
    docs,
    dir,
    spec: path.join(dir, "spec.md"),
    plan: path.join(dir, "plan.md"),
    sdd: path.join(dir, "sdd"),
  };
};

/** Read-only legacy detection (DC-04): never mutates legacy state. */
export const probeLegacyDocs = (workspace: string): LegacyProbe => ({
  legacy_sdd: existsSync(path.join(workspace, ".superpowers", "sdd")),
  superpowers_dir: existsSync(path.join(workspace, "docs", LEGACY_SLUG)),
});

/**
 * The one canonical workspace/slug/pair resolver. Given a slug or any spec/plan
 * pair path, returns canonical paths for the pair. Rejects absolute paths,
 * traversal, symlink escapes, cross-slug pairs, wrong basenames, and arbitrary
 * or legacy locations (DC-01, DC-02). Creates nothing.
 */
export const resolveCanonicalLayout = (input: {
  workspace_root: string;
  slug?: string;
  spec_path?: string;
  plan_path?: string;
}): LayoutResult => {
  const { workspace_root, slug, spec_path, plan_path } = input;
  if (!workspace_root) return { ok: false, error: "workspace_root required" };
  let workspace: string;
  try {
    workspace = realpathSync(path.resolve(workspace_root));
  } catch {
    return { ok: false, error: `workspace root not found: ${workspace_root}` };
  }

  let derived: string | null = null;
  for (const [candidate, kind] of [
    [spec_path, "spec"],
    [plan_path, "plan"],
  ] as const) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      return { ok: false, error: `absolute path not allowed: ${candidate}` };
    }
    // Exact-spelling contract (DC-01): the caller path must be written as the
    // canonical `docs/<slug>/spec.md` / `docs/<slug>/plan.md` — no `./`,
    // no `..` segments, no repeated or trailing separators. The strict regex
    // below rejects those spellings before any bytes are read or resolved.
    const spelling = posix(candidate);
    const match = spelling.match(/^docs\/([^/]+)\/(spec|plan)\.md$/);
    if (!match) {
      return {
        ok: false,
        error: `path must be docs/<slug>/(spec|plan).md inside workspace_root: ${candidate}`,
      };
    }
    const pathSlug = match[1];
    if (pathSlug === LEGACY_SLUG) {
      return { ok: false, error: `legacy path not allowed: ${candidate}` };
    }
    if (!SLUG_RE.test(pathSlug)) {
      return { ok: false, error: `invalid slug derived from path: ${JSON.stringify(pathSlug)}` };
    }
    if (match[2] !== kind) {
      return {
        ok: false,
        error: `wrong basename for ${kind}: expected ${kind}.md, got ${path.basename(candidate)}`,
      };
    }
    if (derived && derived !== pathSlug) {
      return {
        ok: false,
        error: "cross-slug pair: spec_path and plan_path must share the same docs/<slug>/",
      };
    }
    derived = pathSlug;
    // Symlink/canonical containment (DC-02): after the exact-spelling match,
    // resolve the canonical path so a symlinked docs/<slug> or doc file that
    // escapes the workspace or resolves to a different slug is still rejected.
    let abs: string;
    try {
      abs = canonicalize(workspace, candidate);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (posix(path.relative(workspace, abs)) !== spelling) {
      return {
        ok: false,
        error: `path must resolve to ${JSON.stringify(spelling)}: ${candidate}`,
      };
    }
  }

  let resolvedSlug = slug;
  if (resolvedSlug !== undefined) {
    if (!SLUG_RE.test(resolvedSlug)) {
      return { ok: false, error: `invalid slug: ${JSON.stringify(resolvedSlug)}` };
    }
    if (resolvedSlug === LEGACY_SLUG) {
      return { ok: false, error: `reserved slug: ${LEGACY_SLUG}` };
    }
    if (derived && derived !== resolvedSlug) {
      return {
        ok: false,
        error: `slug ${JSON.stringify(resolvedSlug)} does not match docs path ${JSON.stringify(derived)}`,
      };
    }
  } else if (derived) {
    resolvedSlug = derived;
  } else {
    return { ok: false, error: "slug or spec_path/plan_path required" };
  }

  try {
    return { ok: true, layout: buildLayout(workspace, resolvedSlug) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Prepare the canonical layout (DC-04): create only missing `docs/` and
 * `docs/<slug>/`, return canonical (realpath) paths, and probe legacy state
 * read-only. Never creates sdd/, spec.md, or plan.md.
 */
export const prepareDocsLayout = (input: {
  workspace_root: string;
  slug?: string;
  spec_path?: string;
  plan_path?: string;
}): PrepareResult => {
  const resolved = resolveCanonicalLayout(input);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { layout } = resolved;
  const created: string[] = [];
  const ensure = (dir: string) => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      const rel = posix(path.relative(layout.workspace, dir));
      created.push(rel || ".");
    } else if (!statSync(dir).isDirectory()) {
      throw new Error(
        `path exists but is not a directory: ${posix(path.relative(layout.workspace, dir))}`,
      );
    }
  };
  try {
    ensure(layout.docs);
    ensure(layout.dir);
    // Re-canonicalize after creation so a symlinked docs/<slug> that escapes
    // the workspace is rejected, not silently accepted (DC-02).
    const docs = canonicalize(layout.workspace, "docs");
    const dir = canonicalize(layout.workspace, path.join(docs, layout.slug));
    return {
      ok: true,
      layout: { ...layout, docs, dir },
      created,
      legacy: probeLegacyDocs(layout.workspace),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Containment check for paths that must live inside the workspace docs tree
 * (sdd dirs, progress files, plan links). Rejects absolute paths, escapes, and
 * the reserved legacy root `docs/superpowers/`.
 */
export const resolveDocsPath = (input: {
  workspace_root: string;
  path: string;
}): { ok: true; path: string; relative: string; base: string } | { ok: false; error: string } => {
  if (path.isAbsolute(input.path)) {
    return { ok: false, error: `absolute path not allowed: ${input.path}` };
  }
  let workspace: string;
  try {
    workspace = realpathSync(path.resolve(input.workspace_root));
  } catch {
    return { ok: false, error: `workspace root not found: ${input.workspace_root}` };
  }
  try {
    const abs = canonicalize(workspace, input.path);
    const relative = posix(path.relative(workspace, abs));
    if (
      !relative.startsWith("docs/") ||
      relative === `docs/${LEGACY_SLUG}` ||
      relative.startsWith(`docs/${LEGACY_SLUG}/`)
    ) {
      return {
        ok: false,
        error: `path must live under docs/ and not under docs/${LEGACY_SLUG}/: ${input.path}`,
      };
    }
    return { ok: true, path: abs, relative, base: workspace };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
