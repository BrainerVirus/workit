#!/usr/bin/env bun
// Workit's own release pipeline over `workit changelog roll|release`'s core
// (packages/workit-core/src/core/changelog-roll.ts), with the repo's
// `workit-dev-v*` tags and the release-notes block release.config.cjs puts in
// each GitHub release body:
//
//   bun scripts/roll-changelog.ts                    # roll released entries (any PR)
//   bun scripts/roll-changelog.ts --release 2.12.0   # release prepare: the rest go to 2.12.0
//   bun scripts/roll-changelog.ts --notes 2.12.0     # release generateNotes: print 2.12.0's block
//
// A release never writes back to main, so the release job rolls only its own
// checkout; main gets the same split from a PR that runs this script.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Entry,
  type Exec,
  type Group,
  type RollOptions,
  type RollResult,
  type TagSnapshot,
  compareVersions,
  parseChangelog,
  RELEASE_VERSION,
  refusalLines,
  renderGroups,
  repoBase,
  rollChangelog as rollWithPrefix,
  rollRefusal,
  tagSnapshots as snapshotsWithPrefix,
  trimBlank,
  versionGroups,
} from "../packages/workit-core/src/core/changelog-roll";
import { TAG_PREFIX } from "../packages/workit-core/scripts/analyze-release-scope";

export {
  type Exec,
  lostLines,
  parseChangelog,
  parseGroups,
  shippedUnreleased,
  versionGroups,
} from "../packages/workit-core/src/core/changelog-roll";

/** Moves every [Unreleased] entry a release shipped into its section; tags default to `workit-dev-v`. */
export const rollChangelog = (
  text: string,
  opts: Omit<RollOptions, "tagPrefix"> & { tagPrefix?: string },
): RollResult => rollWithPrefix(text, { ...opts, tagPrefix: opts.tagPrefix ?? TAG_PREFIX });

/** Every `workit-dev-v<x.y.z>` tag (or `prefix`), oldest first, with its CHANGELOG.md keys. */
export const tagSnapshots = (
  exec: Exec,
  prefix = TAG_PREFIX,
  file = "CHANGELOG.md",
): TagSnapshot[] => snapshotsWithPrefix(exec, prefix, file);

export const MARKER_START = "<!-- workit:changelog:start -->";
export const MARKER_END = "<!-- workit:changelog:end -->";

/** GitHub rejects a release body over this many characters. */
export const GITHUB_BODY_LIMIT = 125_000;

/**
 * The changelog block's share of a release body. clean-release-notes.cjs caps
 * the commit list at an estimate of 100000 characters (the estimate over-counts),
 * so 24000 more keeps the whole body under GITHUB_BODY_LIMIT.
 */
export const RELEASE_BLOCK_CAP = 24_000;

/**
 * A release's entries between markers, at most `cap` characters. Past the cap
 * it keeps the entries that fit and ends with a line pointing at `more` (the
 * compare view), so GitHub never rejects the body. Empty when there are none
 * or not even that line fits.
 */
export function changelogBlock(groups: Group[], opts: { cap: number; more: string }): string {
  const entries = groups.reduce((n, g) => n + g.entries.length, 0);
  if (entries === 0) return "";
  const wrap = (lines: string[]): string => [MARKER_START, ...lines, MARKER_END].join("\n");
  const whole = wrap(renderGroups(groups));
  if (whole.length <= opts.cap) return whole;

  // Room for the markers and the closing line.
  let budget = opts.cap - MARKER_START.length - MARKER_END.length - opts.more.length - 120;
  const kept: Group[] = [];
  let shown = 0;
  for (const group of groups) {
    const fit: Entry[] = [];
    const cost = (group.heading?.length ?? 0) + 3;
    for (const entry of group.entries) {
      const size = trimBlank(entry.lines).join("\n").length + 1 + (fit.length === 0 ? cost : 0);
      if (size > budget) {
        budget = -1;
        break;
      }
      budget -= size;
      fit.push(entry);
    }
    if (fit.length > 0) kept.push({ heading: group.heading, entries: fit });
    shown += fit.length;
    if (budget < 0) break;
  }
  const rest = entries - shown;
  const cut = wrap([
    ...renderGroups(kept),
    ...(kept.length > 0 ? [""] : []),
    `_${rest} more ${rest === 1 ? "entry is" : "entries are"} not listed here; see ${opts.more}._`,
  ]);
  // A body with no room even for the closing line keeps no block at all.
  return cut.length <= opts.cap ? cut : "";
}

/** A release body with `block` at the top, replacing any block it already had. */
export function withChangelogBlock(body: string, block: string): string {
  const text = body.replace(/\r\n/g, "\n");
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END, start);
  const rest = (
    start >= 0 && end > start ? text.slice(0, start) + text.slice(end + MARKER_END.length) : text
  ).trim();
  if (block === "") return rest;
  return rest === "" ? block : `${block}\n\n${rest}`;
}

/** The link a cut block points at: the release's compare view, else CHANGELOG.md. */
export function moreLink(
  base: string | null,
  previousTag: string | undefined,
  tag: string,
): string {
  if (base === null) return "CHANGELOG.md";
  if (!previousTag) return `[CHANGELOG.md](${base}/blob/${tag}/CHANGELOG.md)`;
  return `the full comparison [${previousTag}...${tag}](${base}/compare/${previousTag}...${tag})`;
}

/** `https://github.com/<owner>/<repo>` for an origin remote URL, or null. */
export const githubBase = (remote: string): string | null => {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
};

export const defaultExec =
  (root: string): Exec =>
  (cmd, args, input) =>
    execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });

const today = (): string => new Date().toISOString().slice(0, 10);

const USAGE = [
  "usage: bun scripts/roll-changelog.ts                     roll released [Unreleased] entries into their sections",
  "       bun scripts/roll-changelog.ts --release <x.y.z>   also move the rest into <x.y.z> (release prepare)",
  "       bun scripts/roll-changelog.ts --notes <x.y.z>     print <x.y.z>'s release-notes block; writes nothing",
  "       --date <YYYY-MM-DD> dates a new --release section (default: today, UTC)",
].join("\n");

/** `--name value` options; null for anything else (an unknown flag, a stray word, --help). */
function parseArgs(args: string[]): Record<string, string> | null {
  const known = new Set(["--notes", "--release", "--date"]);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? "";
    const value = args[i + 1];
    if (!known.has(name) || value === undefined || value.startsWith("--") || name in out)
      return null;
    out[name] = value;
  }
  return out;
}

/** The CLI; returns the exit code. */
export function main(
  args: string[],
  io: { root: string; exec?: Exec; out: (s: string) => void; err: (s: string) => void },
): number {
  const opts = parseArgs(args);
  if (opts === null) {
    io.err(USAGE);
    return 2;
  }
  const notes = opts["--notes"];
  const release = opts["--release"] ?? notes;
  const date = opts["--date"] ?? today();
  if (release !== undefined && !RELEASE_VERSION.test(release)) {
    io.err(`not a release version: ${JSON.stringify(release)}`);
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    io.err(`not a date: ${JSON.stringify(date)}`);
    return 2;
  }
  const exec = io.exec ?? defaultExec(io.root);
  const file = resolve(io.root, "CHANGELOG.md");
  const text = readFileSync(file, "utf8");
  const snapshots = tagSnapshots(exec);
  const rolled = rollChangelog(text, {
    snapshots,
    release: release === undefined ? undefined : { version: release, date },
  });
  if (notes !== undefined) {
    const previous = snapshots.findLast((s) => compareVersions(s.version, notes) < 0);
    const block = changelogBlock(versionGroups(rolled.text, notes), {
      cap: RELEASE_BLOCK_CAP,
      more: moreLink(
        repoBase(parseChangelog(text).links),
        previous ? `${TAG_PREFIX}${previous.version}` : undefined,
        `${TAG_PREFIX}${notes}`,
      ),
    });
    if (block) io.out(block);
    return 0;
  }
  if (!rolled.changed) {
    io.err("CHANGELOG.md: no [Unreleased] entry has shipped; nothing to roll");
    return 0;
  }
  // Fail closed: write nothing rather than a file with text lost or doubled.
  const refusal = rollRefusal(text, rolled);
  if (refusal) {
    for (const line of refusalLines("CHANGELOG.md", refusal)) io.err(line);
    return 1;
  }
  writeFileSync(file, rolled.text);
  for (const { version, entries } of rolled.moved)
    io.err(`CHANGELOG.md: ${entries} entr${entries === 1 ? "y" : "ies"} -> [${version}]`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    root: process.cwd(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
