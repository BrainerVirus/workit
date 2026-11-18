#!/usr/bin/env bun
// Backfills GitHub release notes that the release pipeline lost:
// - releases whose body is header-only (the notes writer listed only
//   feat/fix/perf before every release-triggering type had a section), and
// - tags with no GitHub release at all (v8.41.0: npm publish failed before
//   @semantic-release/github ran).
// Notes are regenerated with the release-notes-generator options from
// release.config.cjs, so they match what a release writes today.
//
//   bun scripts/backfill-release-notes.ts v8.35.0..v8.44.2           # dry run
//   bun scripts/backfill-release-notes.ts v8.35.0..v8.44.2 --apply   # writes
//
// Dry run is the default: it prints each change it would make and touches
// nothing. --apply runs `gh release edit` / `gh release create` (the created
// release is never marked latest).
//
// --changelog puts each release's CHANGELOG.md entries (scripts/roll-changelog.ts
// attributes every entry to the first tag holding it) above the PR-title list
// of its existing GitHub release, between workit:changelog markers. Re-running
// replaces the block, so a second run changes nothing:
//
//   bun scripts/backfill-release-notes.ts --changelog --dry-run            # every workit-dev-v* release
//   bun scripts/backfill-release-notes.ts --changelog workit-dev-v1.0.0..workit-dev-v2.11.0 --apply
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TAG_PREFIX } from "../packages/workit-core/scripts/analyze-release-scope";
import {
  GITHUB_BODY_LIMIT,
  changelogBlock,
  defaultExec,
  githubBase,
  moreLink,
  rollChangelog,
  tagSnapshots,
  versionGroups,
  withChangelogBlock,
} from "./roll-changelog";

/** Runs a command and returns its stdout; throws on a non-zero exit. */
export type Exec = (cmd: string, args: string[], input?: string) => string;

export interface BackfillChange {
  tag: string;
  action: "create" | "edit";
  notes: string;
}

interface NotesContext {
  commits: Array<{ hash: string; message: string }>;
  lastRelease: { gitTag: string };
  nextRelease: { version: string; gitTag: string };
  options: { repositoryUrl: string };
  cwd: string;
}

// The plugin ships no types; this is the one call semantic-release makes.
const { generateNotes } = createRequire(import.meta.url)(
  "@semantic-release/release-notes-generator",
) as {
  generateNotes: (pluginConfig: Record<string, unknown>, context: NotesContext) => Promise<string>;
};

/** The release-notes-generator options a release uses, from release.config.cjs. */
const notesOptions = (root: string): Record<string, unknown> => {
  const config = createRequire(import.meta.url)(resolve(root, "release.config.cjs")) as {
    plugins: unknown[];
  };
  const entry = config.plugins.find(
    (p) => Array.isArray(p) && p[0] === "@semantic-release/release-notes-generator",
  );
  if (!Array.isArray(entry)) throw new Error("release.config.cjs has no release-notes-generator");
  return entry[1] as Record<string, unknown>;
};

/** Release notes exactly as the release pipeline writes them. */
export const releaseNotes = (root: string, context: Omit<NotesContext, "cwd">): Promise<string> =>
  generateNotes(notesOptions(root), { ...context, cwd: root });

/**
 * A stable release tag and its tag family: `workit-dev-v<x.y.z>` for the
 * @workit-dev packages, `v<x.y.z>` for the 14.x releases before them.
 * A range stays inside the family its `<from>` tag belongs to.
 */
const STABLE_TAG = /^(workit-dev-v|v)(\d+\.\d+\.\d+)$/;

/** True when a release body has nothing below its version heading. */
export const isHeaderOnly = (body: string): boolean =>
  body.split("\n").every((line) => line.trim() === "" || /^#{1,3} /.test(line));

/** The release body for `tag`, or null when the tag has no GitHub release. */
const releaseBody = (exec: Exec, tag: string): string | null => {
  try {
    return exec("gh", ["release", "view", tag, "--json", "body", "--jq", ".body"]);
  } catch (e) {
    if (/release not found/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
};

export async function backfillReleaseNotes(opts: {
  root: string;
  /** `<from>..<to>`, both tags included. */
  range: string;
  apply?: boolean;
  exec?: Exec;
  log?: (line: string) => void;
}): Promise<BackfillChange[]> {
  const { root, apply = false } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const exec: Exec = opts.exec ?? defaultExec(root);
  const [from, to] = opts.range.split("..");
  if (!from || !to) throw new Error(`range must be <from-tag>..<to-tag>, got "${opts.range}"`);
  const prefix = STABLE_TAG.exec(from)?.[1] ?? TAG_PREFIX;
  const tags = exec("git", ["tag", "--list", `${prefix}*`, "--sort=v:refname"])
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => STABLE_TAG.exec(t)?.[1] === prefix);
  const start = tags.indexOf(from);
  const end = tags.indexOf(to);
  if (start < 0 || end < 0 || end < start) throw new Error(`no tag range ${opts.range}`);
  const repositoryUrl = exec("git", ["remote", "get-url", "origin"]).trim();
  const changes: BackfillChange[] = [];

  for (let i = Math.max(start, 1); i <= end; i++) {
    const tag = tags[i];
    const previous = tags[i - 1];
    const body = releaseBody(exec, tag);
    if (body !== null && !isHeaderOnly(body)) continue;
    const commits = exec("git", ["log", "--format=%H%x1f%B%x1e", `${previous}..${tag}`])
      .split("\x1e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = "", message = ""] = record.split("\x1f");
        return { hash, message };
      });
    const generated = await releaseNotes(root, {
      commits,
      lastRelease: { gitTag: previous },
      nextRelease: { version: tag.slice(prefix.length), gitTag: tag },
      options: { repositoryUrl },
    });
    // The writer dates the heading today; the release happened on the tag date.
    const date = exec("git", ["log", "-1", "--format=%cs", tag]).trim();
    const notes = generated.replace(/\(\d{4}-\d{2}-\d{2}\)$/m, `(${date})`);
    if (isHeaderOnly(notes)) {
      log(`skip ${tag}: no commit since ${previous} belongs in release notes`);
      continue;
    }
    const action = body === null ? "create" : "edit";
    changes.push({ tag, action, notes });
    log(
      `${apply ? "" : "would "}${action} the GitHub release ${tag}${body === null ? " (missing)" : " (header-only notes)"}:`,
    );
    log(notes);
    if (!apply) continue;
    if (action === "create")
      exec(
        "gh",
        [
          "release",
          "create",
          tag,
          "--verify-tag",
          "--title",
          tag,
          "--latest=false",
          "--notes-file",
          "-",
        ],
        notes,
      );
    else exec("gh", ["release", "edit", tag, "--notes-file", "-"], notes);
  }
  if (changes.length === 0) log(`nothing to backfill in ${opts.range}`);
  else if (!apply) log(`dry run: ${changes.length} change(s); re-run with --apply to write them`);
  return changes;
}

export interface ChangelogBackfill {
  tag: string;
  /** Changelog entries the release body lists after the change. */
  entries: number;
  body: string;
}

const plural = (n: number): string => `${n} changelog ${n === 1 ? "entry" : "entries"}`;

/** Room a release body keeps below GitHub's limit for the edit's own overhead. */
const BODY_MARGIN = 1000;

/**
 * Puts each release's CHANGELOG.md entries at the top of its GitHub release
 * body, replacing the block a previous run or the release itself wrote. A
 * release whose body already says the same is left alone; a tag with no
 * GitHub release is skipped (the default mode creates missing ones).
 */
export function backfillChangelogNotes(opts: {
  root: string;
  /** `<from>..<to>`, both tags included; every release tag when omitted. */
  range?: string;
  apply?: boolean;
  exec?: Exec;
  log?: (line: string) => void;
}): ChangelogBackfill[] {
  const { root, apply = false } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const exec: Exec = opts.exec ?? defaultExec(root);
  const snapshots = tagSnapshots(exec);
  const tags = snapshots.map((s) => s.tag);
  let [start, end] = [0, tags.length - 1];
  if (opts.range !== undefined) {
    const [from = "", to = ""] = opts.range.split("..");
    [start, end] = [tags.indexOf(from), tags.indexOf(to)];
    if (start < 0 || end < start) throw new Error(`no tag range ${opts.range}`);
  }
  const text = rollChangelog(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), {
    snapshots,
  }).text;
  const base = githubBase(exec("git", ["remote", "get-url", "origin"]));
  const changes: ChangelogBackfill[] = [];
  let unchanged = 0;

  for (let i = start; i <= end; i++) {
    const { tag, version } = snapshots[i];
    const body = releaseBody(exec, tag);
    if (body === null) {
      log(`${tag}: skip, no GitHub release`);
      continue;
    }
    const groups = versionGroups(text, version);
    const entries = groups.reduce((n, g) => n + g.entries.length, 0);
    const rest = withChangelogBlock(body, "");
    const block = changelogBlock(groups, {
      cap: GITHUB_BODY_LIMIT - BODY_MARGIN - rest.length,
      more: moreLink(base, tags[i - 1], tag),
    });
    const next = withChangelogBlock(body, block);
    if (next === body.replace(/\r\n/g, "\n").trim()) {
      unchanged += 1;
      log(`${tag}: unchanged (${plural(entries)})`);
      continue;
    }
    changes.push({ tag, entries, body: next });
    log(
      `${tag}: ${apply ? "updated" : "would update"}, ${plural(entries)} (body ${body.trim().length} -> ${next.length} chars)`,
    );
    if (apply) exec("gh", ["release", "edit", tag, "--notes-file", "-"], next);
  }
  log(
    `${apply ? "" : "dry run: "}${changes.length} release(s) ${apply ? "updated" : "to update"}, ${unchanged} unchanged${apply || changes.length === 0 ? "" : "; re-run with --apply to write them"}`,
  );
  return changes;
}

const USAGE =
  "usage: bun scripts/backfill-release-notes.ts <from-tag>..<to-tag> [--dry-run|--apply]\n" +
  "       bun scripts/backfill-release-notes.ts --changelog [<from-tag>..<to-tag>] [--dry-run|--apply]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const range = args.find((a) => a.includes(".."));
  const apply = args.includes("--apply");
  const unknown = args.filter(
    (a) => a !== range && !["--changelog", "--dry-run", "--apply"].includes(a),
  );
  if (unknown.length > 0 || args.filter((a) => a.includes("..")).length > 1) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (apply && args.includes("--dry-run")) {
    console.error("--apply and --dry-run are exclusive");
    process.exitCode = 2;
  } else if (args.includes("--changelog")) {
    backfillChangelogNotes({ root: process.cwd(), range, apply });
  } else if (range === undefined) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    await backfillReleaseNotes({ root: process.cwd(), range, apply });
  }
}
