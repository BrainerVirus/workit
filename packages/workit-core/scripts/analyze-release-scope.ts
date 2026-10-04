#!/usr/bin/env bun
// AR-16: path-gated releases. A releasable commit counts only when it touches
// a PRODUCT PATH (any of the four package dirs). Tooling-only merges produce no
// release at all. A payload change typed docs/chore still publishes as patch —
// skills and metadata live in the tarball, so installed users must receive
// them; merge-backs and the release's own manifest sync never do.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import BUNDLED_DEPS_JSON from "./bundled-deps.json" with { type: "json" };

export const RELEASE_PACKAGES = [
  "workit-core",
  "workit-mcp",
  "workit-cli",
  "workit-opencode",
  "workit-cursor",
  "workit-codex",
  "workit-pi",
  "workit-claude-code",
] as const;

type ReleasePackage = (typeof RELEASE_PACKAGES)[number];

/**
 * Sources a package's published dist/ inlines from OUTSIDE its own directory.
 * Every adapter build is a no-external `bun build`, so whatever it imports
 * from another workspace package is copied into its bundle: a runtime
 * dependency on that package does not reach the shipped code. A change in
 * these sources must therefore republish the bundling package too. Verified
 * against the build entries' metafiles by
 * test/workit-core/bundled-sources.test.ts.
 */
const CORE = "packages/workit-core/"; // sources, skills, templates and package.json
// Cursor and Codex inline the MCP transport and its declared dependencies.
const MCP = ["packages/workit-mcp/src/", "packages/workit-mcp/package.json"];
// The bundled CLI inlines its sources, package.json (`workit --version`) and
// its third-party dependencies.
const CLI = ["packages/workit-cli/src/", "packages/workit-cli/package.json"];
export const BUNDLED_SOURCES: Partial<Record<ReleasePackage, readonly string[]>> = {
  "workit-mcp": [CORE],
  "workit-cli": [CORE],
  "workit-opencode": [CORE],
  "workit-cursor": [CORE, ...MCP],
  "workit-codex": [CORE, ...MCP],
  "workit-pi": [CORE],
  "workit-claude-code": [CORE, ...CLI],
};

/**
 * Third-party packages each dist/ inlines, as bun.lock `packages` keys
 * (`zod`, or `@opencode-ai/plugin/zod` for a nested copy). A lockfile change
 * republishes a package only when one of these resolves to a different
 * version, so dev-tooling bumps never release. Kept in sync with the bundle
 * metafiles by test/workit-core/bundled-sources.test.ts.
 */
export const BUNDLED_DEPS = BUNDLED_DEPS_JSON as Partial<Record<ReleasePackage, string[]>>;

const LOCKFILE = "bun.lock";

/** `packages` key → resolved `name@version` from a bun.lock text (JSONC). */
export const lockResolutions = (text: string): Map<string, string> => {
  // bun.lock is JSON with trailing commas.
  const parsed = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as {
    packages?: Record<string, unknown>;
  };
  const resolved = new Map<string, string>();
  for (const [key, entry] of Object.entries(parsed.packages ?? {}))
    if (Array.isArray(entry) && typeof entry[0] === "string") resolved.set(key, entry[0]);
  return resolved;
};

const lockAt = (root: string, rev: string): Map<string, string> | null => {
  try {
    return lockResolutions(
      execFileSync("git", ["show", `${rev}:${LOCKFILE}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch {
    return null;
  }
};

/** Packages whose inlined third-party resolutions differ between two revisions. */
export const lockChangedPackages = (root: string, from: string, to: string): ReleasePackage[] => {
  const before = lockAt(root, from);
  const after = lockAt(root, to);
  if (before === null && after === null) return [];
  return RELEASE_PACKAGES.filter((pkg) =>
    (BUNDLED_DEPS[pkg] ?? []).some((key) => before?.get(key) !== after?.get(key)),
  );
};

/** Every repository path whose change alters `pkg`'s published payload. */
export const payloadPaths = (pkg: ReleasePackage): string[] => [
  `packages/${pkg}/`,
  ...(BUNDLED_SOURCES[pkg] ?? []),
];

/** The release pipeline's own version-sync commit: never a release trigger. */
const RELEASE_SYNC = /^chore\(release\): sync manifests\b/;

const g = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const SEMVER_TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function latestTag(root = process.cwd()): string | null {
  const tag = g(root, ["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .map((l) => l.trim())
    .find((l) => SEMVER_TAG.test(l));
  return tag ?? null;
}

type Level = "major" | "minor" | "patch";
const LEVEL_RANK: Record<Level, number> = { patch: 1, minor: 2, major: 3 };
const TYPE_LEVEL: Record<string, Level> = { fix: "patch", perf: "patch", feat: "minor" };

const subjectLevel = (commit: string): Level | null => {
  const firstLine = commit.split("\n")[0] ?? "";
  const m = /^([a-z][a-z0-9-]*)(?:\([^)]*\))?(!)?:/.exec(firstLine);
  if (!m) return null;
  if (m[2]) return "major";
  const body = commit.split("\n").slice(1).join("\n");
  if (/BREAKING[- ]CHANGE:/.test(body)) return "major";
  return TYPE_LEVEL[m[1]] ?? null;
};

// Two-pass collection (sanctioned by the task brief): the single-pass
// `%H<NUL>%s%n%b` + `--name-only` interleave is brittle because execFileSync
// rejects NUL bytes inside arguments. Bounded by commit count; acceptable for
// this repo's cadence.
//
// diff-tree with -m unions files across a merge's parents (a plain `show`
// combined diff drops files identical to either parent — e.g. hotfix-branch
// back-merges), and -z returns raw NUL-delimited paths so spaces/non-ASCII
// are never C-quoted. NUL is fine in captured output, never in argv.
const commitsSince = (
  root: string,
  from: string,
): { hash: string; message: string; files: string[] }[] => {
  const hashes = g(root, ["log", "--reverse", "--format=%H", `${from}..HEAD`])
    .split("\n")
    .filter(Boolean);
  return hashes.map((h) => ({
    hash: h,
    message: g(root, ["show", "-s", "--format=%B", h]),
    files: g(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", "-z", h])
      .split("\0")
      .filter(Boolean),
  }));
};

export function analyzeReleaseScope(root = process.cwd()): {
  level: Level | null;
  productPkgs: string[];
} {
  const from = latestTag(root);
  if (from === null) {
    return { level: "minor", productPkgs: [...RELEASE_PACKAGES] };
  }
  const commits = commitsSince(root, from);
  const levels: Level[] = [];
  const pkgs = new Set<string>();
  let payloadOnly = false;
  for (const { hash, message, files } of commits) {
    const subject = (message.split("\n")[0] ?? "").trim();
    if (RELEASE_SYNC.test(subject)) continue;
    const touched = files.filter((f) =>
      RELEASE_PACKAGES.some((p) => payloadPaths(p).some((prefix) => f.startsWith(prefix))),
    );
    // A lockfile edit counts only for packages whose inlined deps moved.
    const relocked = files.includes(LOCKFILE) ? lockChangedPackages(root, `${hash}^`, hash) : [];
    if (touched.length === 0 && relocked.length === 0) continue;
    const lvl = subjectLevel(message);
    if (lvl) levels.push(lvl);
    else if (!subject.startsWith("Merge ")) payloadOnly = true;
    for (const pkg of RELEASE_PACKAGES)
      if (
        relocked.includes(pkg) ||
        touched.some((f) => payloadPaths(pkg).some((prefix) => f.startsWith(prefix)))
      )
        pkgs.add(pkg);
  }
  if (levels.length === 0) return { level: payloadOnly ? "patch" : null, productPkgs: [...pkgs] };
  const level = levels.reduce<Level>(
    (best, l) => (LEVEL_RANK[l] > LEVEL_RANK[best] ? l : best),
    "patch",
  );
  return { level, productPkgs: [...pkgs] };
}

if (import.meta.main) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const { level } = analyzeReleaseScope(root);
  if (level) process.stdout.write(`${level}\n`);
}
