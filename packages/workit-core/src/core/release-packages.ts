// Release packages (#860): several packages released from one repository's
// own release line, each under its own tag namespace (`pkg-a@0.1.0` beside the
// workspace's bare `4.6.0`). They are branchless on purpose: never a release
// track, never in releaseLinesOf or track resolution, so a feature branch
// resolves exactly as before. A package tag is `<tagNamespace><version>` with
// no workspace releaseTagPrefix appended, on the workspace's production branch.
//
// readReleasePackages is the lenient runtime reader (D17): a malformed entry
// or field is reported and ignored, never fatal.
import { existsSync } from "node:fs";
import path from "node:path";
import { gitDirs } from "../git/facts";
import { resolveChangelogPaths } from "./changelog-gate";
import { changelogPathOf, resolveRuntimeReleasePackages, workspaceChangelog } from "./workspaces";

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
const validTagNamespace = (value: string): boolean =>
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

/**
 * The changelog file of a release package at `ref`: its changelogPath, else
 * the workspace changelog (changelogPath list or glob, resolved at `ref`) in
 * a directory named like the package (its last `/` segment: `@scope/pkg-a`
 * is `pkg-a`). Null when none matches. The one rule the release, the notes
 * and the doctor share.
 */
export function packageChangelogFile(
  cwd: string,
  ref: string,
  pkg: ReleasePackage,
  files: readonly string[] = resolveChangelogPaths(cwd, workspaceChangelog(cwd).paths, ref),
): string | null {
  if (pkg.changelogPath) return pkg.changelogPath;
  const base = pkg.name.split("/").at(-1);
  return files.find((file) => path.posix.basename(path.posix.dirname(file)) === base) ?? null;
}

/** The tag shapes the packages accept (`pkg-a@<version>`). */
export const packageTagShapes = (packages: readonly ReleasePackage[]): string[] =>
  packages.map((entry) => `${entry.tagNamespace}<version>`);

export type ReleasePackagesReport = {
  workspace: string | null;
  packages: {
    name: string;
    tagShape: string;
    /** As configured; null when the changelog is found by directory name. */
    changelogPath: string | null;
    /** The file packageChangelogFile resolves at HEAD, or null for none. */
    changelog: string | null;
  }[];
  /** Reader issues, and packages whose changelog names or resolves to no file. */
  issues: string[];
  /** Every package whose changelog needs a changelogPath, for the fix line. */
  unresolved: string[];
};

/**
 * cwd's release packages for display (grant show, doctor): each one's tag
 * shape and changelog, the reader's issues, and a configured changelogPath
 * that names no file in this checkout.
 */
export function releasePackagesReport(cwd: string, dir?: string): ReleasePackagesReport {
  let raw: ReturnType<typeof resolveRuntimeReleasePackages>;
  try {
    raw = resolveRuntimeReleasePackages(cwd, dir);
  } catch (error) {
    return {
      workspace: null,
      packages: [],
      issues: [error instanceof Error ? error.message : String(error)],
      unresolved: [],
    };
  }
  const read = readReleasePackages(raw?.releasePackages);
  const root = gitDirs(cwd)?.top ?? null;
  const issues = [...read.issues];
  const files = root ? resolveChangelogPaths(cwd, workspaceChangelog(cwd, dir).paths) : [];
  const unresolved: string[] = [];
  const packages = read.packages.map((pkg) => {
    let changelog: string | null = null;
    if (root) {
      changelog = packageChangelogFile(cwd, "HEAD", pkg, files);
      if (pkg.changelogPath && !existsSync(path.join(root, pkg.changelogPath))) {
        issues.push(
          `release package ${JSON.stringify(pkg.name)} changelogPath ${pkg.changelogPath}: no such file in this checkout`,
        );
        changelog = null;
      } else if (!changelog)
        issues.push(
          `release package ${JSON.stringify(pkg.name)}: no changelog found (no changelogPath, and no workspace changelogPath file is in a directory named ${pkg.name.split("/").at(-1)})`,
        );
      if (!changelog) unresolved.push(pkg.name);
    }
    return {
      name: pkg.name,
      tagShape: `${pkg.tagNamespace}<version>`,
      changelogPath: pkg.changelogPath,
      changelog,
    };
  });
  return { workspace: raw?.workspace ?? null, packages, issues, unresolved };
}

/** One human line per fact, shared by grant show and doctor; none without packages. */
export const describeReleasePackages = (report: ReleasePackagesReport): string[] =>
  report.packages.length === 0 && report.issues.length === 0
    ? []
    : [
        `release packages: ${
          report.packages
            .map(
              (pkg) =>
                `${pkg.name} (${pkg.tagShape}; changelog ${pkg.changelog ?? pkg.changelogPath ?? "none found"})`,
            )
            .join(", ") || "(none usable)"
        }`,
        ...report.issues.map((issue) => `note: ${issue}`),
      ];

/**
 * The doctor's release-packages finding: null when none is configured (and
 * the reader has nothing to say), a warn with a fix on any reader issue or a
 * changelogPath with no file, else a pass listing them.
 */
export function releasePackagesDoctor(
  cwd: string,
  dir?: string,
): { status: "pass" | "warn"; detail: string; fix?: string } | null {
  const report = releasePackagesReport(cwd, dir);
  const lines = describeReleasePackages(report);
  if (lines.length === 0) return null;
  if (report.issues.length === 0) return { status: "pass", detail: lines.join("; ") };
  const ws = report.workspace ?? "<workspace>";
  return {
    status: "warn",
    detail: lines.join("; "),
    fix: `Fix the reported releasePackages entries: ${(report.unresolved.length ? report.unresolved : ["<name>"]).map((name) => `workit workspace set ${ws} releasePackages.${name}.changelogPath=<repo-relative file>`).join("; ")} (or tagNamespace=<prefix>; =null unsets)`,
  };
}
