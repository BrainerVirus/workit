// The Keep a Changelog gate `workit pr create` runs when a workspace opts in
// (`changelog: update|create` in workspaces.json, default off). A user-facing
// PR (any Conventional Commit type but chore, test, docs, ci, build, style,
// or a breaking `!`) needs at least one bullet under `## [Unreleased]` that
// the branch adds against its PR base. The gate only reads: entries are
// written by `workit changelog apply`, never here, so existing entries are
// never rewritten or reordered.
//
// - `update` asks for an entry only where CHANGELOG.md exists at HEAD.
// - `create` asks for it always (`workit changelog apply` creates the file).
// - `--no-changelog "<reason>"` skips it; the reason goes on the PR.
// - A base that does not resolve locally never blocks: the gate says so.
import { spawnSync } from "node:child_process";
import { GIT_TIMEOUTS, mergeBase, pushRemoteName, resolveRef } from "../git/rev";
import type { ChangelogMode } from "./workspaces";

export const CHANGELOG_FILE = "CHANGELOG.md";

/** Conventional Commit types whose change no user sees: no entry needed. */
export const NON_USER_FACING_TYPES = ["chore", "test", "docs", "ci", "build", "style"] as const;

export type ChangelogGate =
  | { status: "off" }
  | { status: "not-user-facing"; mode: ChangelogMode; type: string }
  | { status: "skipped"; mode: ChangelogMode; reason: string }
  | { status: "no-file"; mode: ChangelogMode }
  | { status: "base-unknown"; mode: ChangelogMode; base: string }
  | { status: "has-entry"; mode: ChangelogMode; added: string[] }
  | { status: "missing"; mode: ChangelogMode; category: string; command: string };

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

/** The command that writes the missing entry. */
export const applyCommand = (category: string): string =>
  `workit changelog apply --entries '{"${category}": ["<what users can now do>"]}'`;

/** CHANGELOG.md at `rev`, or null when it is not in that commit. */
const fileAt = (cwd: string, rev: string): string | null => {
  const run = spawnSync("git", ["show", `${rev}:${CHANGELOG_FILE}`], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUTS.local,
    maxBuffer: 64 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
};

/** The PR base as this checkout knows it: the push remote's ref, else the local branch. */
const baseCommit = (cwd: string, base: string): string | null => {
  const remote = pushRemoteName(cwd) ?? "origin";
  return resolveRef(cwd, `refs/remotes/${remote}/${base}`) ?? resolveRef(cwd, `refs/heads/${base}`);
};

/** Whether a PR titled `title` from HEAD into `base` may open under `mode`. */
export function changelogGate(input: {
  cwd: string;
  mode: ChangelogMode;
  title: string;
  base: string;
  skipReason?: string | null;
}): ChangelogGate {
  const { cwd, mode, title, base } = input;
  if (mode === "off") return { status: "off" };
  const type = nonUserFacingType(title);
  if (type) return { status: "not-user-facing", mode, type };
  if (input.skipReason) return { status: "skipped", mode, reason: input.skipReason };
  const head = fileAt(cwd, "HEAD");
  if (head === null && mode === "update") return { status: "no-file", mode };
  const category = categoryFor(title);
  const missing: ChangelogGate = {
    status: "missing",
    mode,
    category,
    command: applyCommand(category),
  };
  if (head === null) return missing;
  const baseRev = baseCommit(cwd, base);
  const fork = baseRev ? mergeBase(cwd, baseRev, "HEAD") : null;
  if (!fork) return { status: "base-unknown", mode, base };
  const before = new Set(unreleasedBullets(fileAt(cwd, fork) ?? "").map((b) => b.toLowerCase()));
  const added = unreleasedBullets(head).filter((bullet) => !before.has(bullet.toLowerCase()));
  return added.length ? { status: "has-entry", mode, added } : missing;
}
