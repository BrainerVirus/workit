// The Keep a Changelog gate `workit pr create` runs when a workspace opts in
// (`changelog: update|create` in workspaces.json, default off). A user-facing
// PR (any Conventional Commit type but chore, test, docs, ci, build, style,
// or a breaking `!`) needs at least one bullet under `## [Unreleased]` that
// the branch adds against its PR base. The gate only reads: entries are
// written by `workit changelog apply`, never here, so existing entries are
// never rewritten or reordered.
//
// - The changelog is CHANGELOG.md at the root unless the workspace sets
//   `changelogPath` (one path, or a list: an entry in any of them counts).
//   A glob entry (`projects/*/CHANGELOG.md`) makes each matched file the
//   changelog of its directory: every such directory the diff touches needs
//   its own entry; a diff touching none of them needs one in any.
// - `update` asks for an entry only where a changelog exists at HEAD.
// - `create` asks for it always (`workit changelog apply` creates the file).
// - `--no-changelog "<reason>"` skips it; the reason goes on the PR.
// - The base is fetched from the base remote first (as `--fill` does); one
//   that still cannot be compared blocks with its own reason and a fetch fix,
//   since an unchecked PR is exactly the forgotten entry the gate exists for.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { GIT_TIMEOUTS, fetchRefs, mergeBase, pushRemoteName, resolveRef } from "../git/rev";
import { DEFAULT_CHANGELOG_PATH, type ChangelogMode } from "./workspaces";

/** Conventional Commit types whose change no user sees: no entry needed. */
const NON_USER_FACING_TYPES = ["chore", "test", "docs", "ci", "build", "style"] as const;

export type ChangelogGate =
  | { status: "off" }
  | { status: "not-user-facing"; mode: ChangelogMode; type: string }
  | { status: "skipped"; mode: ChangelogMode; reason: string }
  | { status: "no-file"; mode: ChangelogMode; paths: string[]; candidates: string[] }
  | { status: "base-unknown"; mode: ChangelogMode; base: string; remote: string; fetch: string }
  | {
      status: "has-entry";
      mode: ChangelogMode;
      file: string;
      added: string[];
      /** Every changelog that gained an entry, when more than one did. */
      files?: string[];
      /** The fetch failed but a local copy of the base resolved: compared with that copy. */
      staleBase?: string;
    }
  | {
      status: "missing";
      mode: ChangelogMode;
      file: string;
      category: string;
      command: string;
      candidates: string[];
      /** The changelog files the check read (the configured paths when none exists). */
      looked: string[];
      /** Package changelogs the diff touches that gained no entry (glob paths only). */
      lacking?: string[];
      staleBase?: string;
    };

const TITLE_RE = /^(\w+)(?:\([^)]*\))?(!)?:/u;
const UNRELEASED_RE = /^##\s+\[Unreleased\][^\n]*\n([\s\S]*?)(?=^##\s+\[|(?![\s\S]))/imu;
const BULLET_RE = /^[-*]\s+(.+?)\s*$/u;

/**
 * The title's Conventional Commit type when it is not user-facing, else null.
 * A breaking change (`chore!:`) and a title that is not a Conventional Commit
 * count as user-facing.
 */
export function nonUserFacingType(title: string): string | null {
  const parsed = TITLE_RE.exec(title.split("\n", 1)[0] ?? "");
  if (!parsed || parsed[2]) return null;
  const type = parsed[1].toLowerCase();
  return (NON_USER_FACING_TYPES as readonly string[]).includes(type) ? type : null;
}

/** The bullets under `## [Unreleased]`, trimmed, in file order. */
export function unreleasedBullets(text: string): string[] {
  const body = UNRELEASED_RE.exec(text.replaceAll("\r\n", "\n"))?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => BULLET_RE.exec(line)?.[1])
    .filter((bullet): bullet is string => Boolean(bullet));
}

/** The Keep a Changelog category a title's change most likely belongs to. */
const categoryFor = (title: string): string => {
  const type = TITLE_RE.exec(title)?.[1]?.toLowerCase();
  return type === "feat" ? "Added" : type === "fix" ? "Fixed" : "Changed";
};

/** The command that writes the missing entry into `file`. */
const applyCommand = (category: string, file: string): string =>
  `workit changelog apply --entries '{"${category}": ["<what users can now do>"]}'${
    file === DEFAULT_CHANGELOG_PATH ? "" : ` --path ${file}`
  }`;

/** `file` (repo-relative) at `rev`, or null when it is not in that commit. */
const fileAt = (cwd: string, rev: string, file: string): string | null => {
  const run = spawnSync("git", ["show", `${rev}:${file}`], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
};

const CHANGELOG_NAME = /(?:^|\/)(?:changelog|changes|history)(?:\.md)?$/iu;

/** Tracked changelog-like files other than the root one, for a hint to set `changelogPath`. */
const candidatesAt = (cwd: string): string[] => {
  const run = spawnSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) return [];
  return run.stdout
    .split("\0")
    .filter((file) => CHANGELOG_NAME.test(file) && file !== DEFAULT_CHANGELOG_PATH)
    .filter((file) => !file.split("/").includes("node_modules"))
    .slice(0, 5);
};

/**
 * The PR base, fetched from the base remote first so a fork or a stale ref
 * never moves the fork point: that remote's ref, else the local branch. The
 * fetch error (offline, no such branch) is kept for the block message.
 */
const baseCommit = (
  cwd: string,
  remote: string,
  base: string,
): { rev: string | null; fetchError: string | null } => {
  const tracking = `refs/remotes/${remote}/${base}`;
  if (base.startsWith("-")) return { rev: null, fetchError: "a branch name cannot start with -" };
  const fetched = fetchRefs(cwd, remote, [`+refs/heads/${base}:${tracking}`]);
  return {
    rev: resolveRef(cwd, tracking) ?? resolveRef(cwd, `refs/heads/${base}`),
    fetchError: fetched.ok ? null : fetched.error,
  };
};

/** Where HEAD forked from the PR base, resolved once for every `pr create` check. */
export type ForkPoint = {
  remote: string;
  base: string;
  /** The merge base of the PR base and HEAD; null when the base is unknown here. */
  fork: string | null;
  /** The base resolved but its fetch failed: the comparison used the older local copy. */
  staleBase: string | null;
  fetchError: string | null;
};

export function resolveForkPoint(cwd: string, base: string, baseRemote?: string): ForkPoint {
  const remote = baseRemote ?? pushRemoteName(cwd) ?? "origin";
  const resolved = baseCommit(cwd, remote, base);
  return {
    remote,
    base,
    fork: resolved.rev ? mergeBase(cwd, resolved.rev, "HEAD") : null,
    staleBase: resolved.rev ? resolved.fetchError : null,
    fetchError: resolved.fetchError,
  };
}

const gitList = (cwd: string, args: string[]): string[] => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout.split("\0").filter(Boolean) : [];
};

/** The files the branch changed since `fork`, repo-relative. */
export const changedSince = (cwd: string, fork: string): string[] =>
  gitList(cwd, ["diff", "--name-only", "-z", "--no-renames", fork, "HEAD"]);

/** Whether a `changelogPath` entry is a glob (`*`, `**`, `?`) rather than one file. */
export const isChangelogGlob = (pattern: string): boolean => /[*?]/u.test(pattern);

const escapeRe = (text: string): string => text.replace(/[.+^${}()|[\]\\]/gu, "\\$&");

/** `*` and `?` stay inside one path segment; `**` spans any number of them. */
const globRe = (pattern: string): RegExp => {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/u)
    .map((part) =>
      part === "**/"
        ? "(?:[^/]+/)*"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "[^/]"
              : escapeRe(part),
    )
    .join("");
  return new RegExp(`^${source}$`, "u");
};

/** One changelog a `changelogPath` entry names; `pkg` is its directory when a glob matched it. */
type ChangelogFile = { file: string; pkg: string | null };

const expand = (paths: readonly string[], tracked: () => string[]): ChangelogFile[] => {
  const seen = new Set<string>();
  const out: ChangelogFile[] = [];
  for (const pattern of paths) {
    const matches = isChangelogGlob(pattern)
      ? tracked()
          .filter((file) => globRe(pattern).test(file))
          .toSorted()
          .map((file) => ({ file, pkg: file.includes("/") ? path.posix.dirname(file) : null }))
      : [{ file: pattern, pkg: null }];
    for (const match of matches)
      if (!seen.has(match.file)) {
        seen.add(match.file);
        out.push(match);
      }
  }
  // Globs that match nothing here (a single-package repo under a monorepo setting) mean the root file.
  if (!out.length && paths.every(isChangelogGlob))
    out.push({ file: DEFAULT_CHANGELOG_PATH, pkg: null });
  return out;
};

const trackedAt = (cwd: string, rev: string) => {
  let files: string[] | null = null;
  return () => (files ??= gitList(cwd, ["ls-tree", "-r", "-z", "--name-only", rev]));
};

/**
 * The changelog files `paths` resolves to at `rev` (default HEAD): each plain
 * path as given, each glob as the tracked files it matches.
 */
export const resolveChangelogPaths = (cwd: string, paths: readonly string[], rev = "HEAD") =>
  expand(paths, trackedAt(cwd, rev)).map(({ file }) => file);

/** The package changelog that owns `file`: the deepest glob-matched directory holding it. */
const ownerOf = (packages: readonly ChangelogFile[], file: string): string | null => {
  let owner: ChangelogFile | null = null;
  for (const candidate of packages)
    if (
      candidate.pkg &&
      file.startsWith(`${candidate.pkg}/`) &&
      candidate.pkg.length > (owner?.pkg?.length ?? -1)
    )
      owner = candidate;
  return owner?.file ?? null;
};

/** Whether a PR titled `title` from HEAD into `base` may open under `mode`. */
export function changelogGate(input: {
  cwd: string;
  mode: ChangelogMode;
  title: string;
  base: string;
  /** The remote the PR targets (the forge's base remote); default the push remote, else origin. */
  baseRemote?: string;
  /**
   * Repo-relative changelog paths or globs (default: CHANGELOG.md). A file a
   * glob matched is its directory's changelog: each such directory the diff
   * touches needs its own entry.
   */
  paths?: string[];
  /** Whether `paths` came from the workspace; if not, a missing root file names candidates. */
  pathConfigured?: boolean;
  skipReason?: string | null;
  /** The fork point, when the caller resolved it already (`pr create` shares it with the docs check). */
  forkPoint?: () => ForkPoint;
}): ChangelogGate {
  const { cwd, mode, title, base } = input;
  const paths = input.paths?.length ? input.paths : [DEFAULT_CHANGELOG_PATH];
  if (mode === "off") return { status: "off" };
  const type = nonUserFacingType(title);
  if (type) return { status: "not-user-facing", mode, type };
  if (input.skipReason) return { status: "skipped", mode, reason: input.skipReason };
  const atHead = expand(paths, trackedAt(cwd, "HEAD"));
  const present = atHead.flatMap((entry) => {
    const text = fileAt(cwd, "HEAD", entry.file);
    return text === null ? [] : [{ ...entry, text }];
  });
  const point = input.forkPoint?.() ?? resolveForkPoint(cwd, base, input.baseRemote);
  const { fork, remote } = point;
  const unknown: ChangelogGate = {
    status: "base-unknown",
    mode,
    base,
    remote,
    fetch: point.fetchError ?? "the base has no common history with this branch here",
  };
  // The fetch failed but an older local copy resolved: the comparison stands, and says so.
  const stale = point.staleBase ? { staleBase: point.staleBase } : {};
  const category = categoryFor(title);
  // A file the base has and the branch deleted is an entry removed, not "nothing to update".
  const deleted = fork
    ? expand(paths, trackedAt(cwd, fork)).find(({ file }) => fileAt(cwd, fork, file) !== null)?.file
    : undefined;
  const looked = present.length ? present.map(({ file }) => file) : paths;
  const candidates = present.length || deleted || input.pathConfigured ? [] : candidatesAt(cwd);
  const missingOf = (file: string, lacking?: string[]): ChangelogGate => ({
    status: "missing",
    mode,
    file,
    category,
    command: applyCommand(category, file),
    candidates,
    looked,
    ...(lacking ? { lacking } : {}),
    ...stale,
  });
  if (!present.length) {
    const file = deleted ?? atHead.find(({ pkg }) => pkg === null)?.file;
    if (file && (mode === "create" || deleted)) return missingOf(file);
    // Without a base the deletion check cannot run; `update` asks nothing of a repo with no file.
    return { status: "no-file", mode, paths, candidates };
  }
  if (!fork) return unknown;
  const entries = present.map(({ file, text }) => {
    const before = new Set(
      unreleasedBullets(fileAt(cwd, fork, file) ?? "").map((bullet) => bullet.toLowerCase()),
    );
    return { file, added: unreleasedBullets(text).filter((b) => !before.has(b.toLowerCase())) };
  });
  const expected = [
    ...new Set(
      changedSince(cwd, fork)
        .map((file) => ownerOf(present, file))
        .filter((file): file is string => file !== null),
    ),
  ];
  const withEntry = entries.filter(({ added }) => added.length);
  if (expected.length) {
    const lacking = expected.filter((file) => !withEntry.some((entry) => entry.file === file));
    if (lacking.length) return missingOf(lacking[0], lacking);
  }
  if (!withEntry.length) return missingOf(present[0].file);
  const [first] = withEntry;
  return {
    status: "has-entry",
    mode,
    file: first.file,
    added: first.added,
    ...(withEntry.length > 1 ? { files: withEntry.map(({ file }) => file) } : {}),
    ...stale,
  };
}
