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
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

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
  const exec: Exec =
    opts.exec ??
    ((cmd, args, input) =>
      execFileSync(cmd, args, {
        cwd: root,
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      }));
  const [from, to] = opts.range.split("..");
  if (!from || !to) throw new Error(`range must be <from-tag>..<to-tag>, got "${opts.range}"`);
  const tags = exec("git", ["tag", "--list", "v*", "--sort=v:refname"])
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => STABLE_TAG.test(t));
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
      nextRelease: { version: tag.slice(1), gitTag: tag },
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const range = args.find((a) => a.includes(".."));
  if (range === undefined) {
    console.error("usage: bun scripts/backfill-release-notes.ts <from-tag>..<to-tag> [--apply]");
    process.exit(2);
  }
  await backfillReleaseNotes({ root: process.cwd(), range, apply: args.includes("--apply") });
}
