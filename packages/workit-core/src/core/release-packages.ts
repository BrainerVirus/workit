// Release packages (#860): several packages released from one repository's
// own release line, each under its own tag namespace (`pkg-a@0.1.0` beside the
// workspace's bare `4.6.0`). They are branchless on purpose: never a release
// track, never in releaseLinesOf or track resolution, so a feature branch
// resolves exactly as before. A package tag is `<tagNamespace><version>` with
// no workspace releaseTagPrefix appended, on the workspace's production branch.
//
// readReleasePackages is the lenient runtime reader (D17): a malformed entry
// or field is reported and ignored, never fatal.
import { changelogPathOf, resolveRuntimeReleasePackages } from "./workspaces";

export type ReleasePackage = {
  name: string;
  /** The tag prefix: `<name>@` unless configured. */
  tagNamespace: string;
  /** The package's own changelog, repo-relative; null to find it among the workspace's. */
  changelogPath: string | null;
};

export type ReleasePackagesRead = {
  packages: ReleasePackage[];
  /** Reported, non-fatal problems (the entry or field was ignored). */
  issues: string[];
};

const KNOWN_FIELDS = new Set(["tagNamespace", "changelogPath"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A tag namespace git can carry and a version cannot be mistaken for: starts
 * with a letter or `@`, no `..`, `@{`, `//`, whitespace or ref-forbidden
 * characters, and no trailing digit (the version starts at the first digit
 * after it).
 */
const NAMESPACE = /^[A-Za-z@][\w.@/+-]*$/u;
export const validTagNamespace = (value: string): boolean =>
  NAMESPACE.test(value) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.includes("//") &&
  !value.endsWith(".lock") &&
  !/\d$/u.test(value);

/** Lenient read of a workspace's raw `releasePackages` value (D17). */
export function readReleasePackages(raw: unknown): ReleasePackagesRead {
  const out: ReleasePackagesRead = { packages: [], issues: [] };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    out.issues.push("releasePackages is not an object; ignored");
    return out;
  }
  const seen = new Map<string, string>();
  for (const [name, entry] of Object.entries(raw).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const label = `release package ${JSON.stringify(name)}`;
    if (!name.trim() || name.trim() !== name) {
      out.issues.push(`${label}: a blank or padded name; ignored`);
      continue;
    }
    if (!isRecord(entry)) {
      out.issues.push(`${label} is not an object; ignored`);
      continue;
    }
    for (const key of Object.keys(entry))
      if (!KNOWN_FIELDS.has(key)) out.issues.push(`${label} ${key}: unknown field, ignored`);
    const tagNamespace =
      typeof entry.tagNamespace === "string" ? entry.tagNamespace.trim() : `${name}@`;
    if (!validTagNamespace(tagNamespace)) {
      out.issues.push(
        `${label} tagNamespace ${JSON.stringify(tagNamespace)}: not a tag prefix (a letter first, no trailing digit); the package is ignored`,
      );
      continue;
    }
    const owner = seen.get(tagNamespace);
    if (owner) {
      out.issues.push(`${label} tagNamespace ${tagNamespace}: already ${owner}'s; ignored`);
      continue;
    }
    let changelogPath: string | null = null;
    if (entry.changelogPath !== undefined) {
      changelogPath = changelogPathOf(entry.changelogPath);
      if (!changelogPath)
        out.issues.push(`${label} changelogPath: not a repo-relative path; ignored`);
    }
    seen.set(tagNamespace, name);
    out.packages.push({ name, tagNamespace, changelogPath });
  }
  return out;
}

/** cwd's release packages (inherited like `changelogPath`); none without a workspace. */
export function workspaceReleasePackages(cwd: string, dir?: string): ReleasePackagesRead {
  let raw: unknown;
  try {
    raw = resolveRuntimeReleasePackages(cwd, dir)?.releasePackages;
  } catch {
    return { packages: [], issues: [] };
  }
  return readReleasePackages(raw);
}

/**
 * The package a tag belongs to: its namespace and a digit (`pkg-a@0.1.0`);
 * the longest matching namespace wins. Null for any other tag.
 */
export function packageOfTag(
  tag: string,
  packages: readonly ReleasePackage[],
): { pkg: ReleasePackage; version: string } | null {
  const pkg = packages
    .filter(
      (entry) =>
        tag.startsWith(entry.tagNamespace) && /^\d/u.test(tag.slice(entry.tagNamespace.length)),
    )
    .toSorted((a, b) => b.tagNamespace.length - a.tagNamespace.length)[0];
  return pkg ? { pkg, version: tag.slice(pkg.tagNamespace.length) } : null;
}

/** The tag shapes the packages accept (`pkg-a@<version>`). */
export const packageTagShapes = (packages: readonly ReleasePackage[]): string[] =>
  packages.map((entry) => `${entry.tagNamespace}<version>`);
