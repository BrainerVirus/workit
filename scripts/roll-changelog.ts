#!/usr/bin/env bun
// Moves CHANGELOG.md entries out of `## [Unreleased]` into the release that
// shipped them, and renders a release's entries for its GitHub release notes.
//
// An entry (a top-level bullet with its continuation lines) belongs to the
// first `workit-dev-v*` tag whose CHANGELOG.md already holds it, so the result
// depends only on the tags, never on when the file was last rolled:
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
import { TAG_PREFIX } from "../packages/workit-core/scripts/analyze-release-scope";

/** Runs a command and returns its stdout; throws on a non-zero exit. */
export type Exec = (cmd: string, args: string[], input?: string) => string;

/** One bullet with its continuation lines (no trailing newline). */
interface Entry {
  lines: string[];
  /** 1-based line of the bullet in the file it was parsed from (0 when built). */
  line: number;
}

/** A `###` group (or the lines before the first one, heading null). */
interface Group {
  heading: string | null;
  entries: Entry[];
}

interface Section {
  /** The bracketed name: `Unreleased` or a version. */
  name: string;
  heading: string;
  /** 0-based index of the heading line in the file. */
  start: number;
  /** Original lines, heading included; rendered as-is unless `groups` is set. */
  raw: string[];
  groups?: Group[];
}

interface Doc {
  preamble: string[];
  sections: Section[];
  links: string[];
}

/** What a tag's CHANGELOG.md held, for attributing entries to releases. */
export interface TagSnapshot {
  tag: string;
  version: string;
  /** YYYY-MM-DD the tag was made. */
  date: string;
  keys: Set<string>;
}

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

const SECTION = /^##\s+\[([^\]]+)\]/;
const GROUP = /^###\s+/;
const BULLET = /^[-*]\s+/;
const LINK = /^\[[^\]]+\]:\s+\S/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const KEY_LENGTH = 100;

const trimBlank = (lines: string[]): string[] => {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out;
};

export function parseChangelog(text: string): Doc {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = trimBlank(lines).length;
  let linkStart = end;
  while (linkStart > 0 && LINK.test(lines[linkStart - 1] ?? "")) linkStart--;
  const links = lines.slice(linkStart, end);
  end = linkStart;
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const [index, line] of lines.slice(0, end).entries()) {
    const match = SECTION.exec(line);
    if (match) sections.push({ name: match[1] ?? "", heading: line, start: index, raw: [line] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1]?.raw.push(line);
  }
  return { preamble, sections, links };
}

/** The groups of a section's body; `start` is the 0-based index of the heading line. */
const sectionGroups = (section: Section): Group[] =>
  parseGroups(section.raw.slice(1), section.start + 2);

/**
 * The groups and entries of a section body (the lines after its heading).
 * `firstLine` is the 1-based file line of `body[0]`, for entries' `line`.
 */
export function parseGroups(body: string[], firstLine = 1): Group[] {
  const groups: Group[] = [];
  let group: Group | null = null;
  let entry: Entry | null = null;
  let blanks: string[] = [];
  for (const [index, line] of body.entries()) {
    if (line.trim() === "") {
      if (entry) blanks.push(line);
      continue;
    }
    if (GROUP.test(line)) {
      group = { heading: line, entries: [] };
      groups.push(group);
      entry = null;
    } else if (BULLET.test(line) || entry === null) {
      if (!group) {
        group = { heading: null, entries: [] };
        groups.push(group);
      }
      entry = { lines: [line], line: firstLine + index };
      group.entries.push(entry);
    } else {
      entry.lines.push(...blanks, line);
    }
    blanks = [];
  }
  return groups;
}

const collapse = (entry: Entry): string =>
  entry.lines.join(" ").replace(BULLET, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * An entry's identity across tags: the start of its text with whitespace
 * collapsed, so rewrapping or editing the tail of an entry keeps the release
 * it first shipped in. `full` is the whole text, used when two entries share
 * the start.
 */
export const entryKeys = (entry: Entry): { short: string; full: string } => {
  const full = collapse(entry);
  return { short: full.slice(0, KEY_LENGTH), full };
};

/** Every short and full key of every bullet in a CHANGELOG.md, any section. */
export function changelogKeys(text: string): Set<string> {
  const doc = parseChangelog(text);
  const keys = new Set<string>();
  for (const section of doc.sections)
    for (const group of sectionGroups(section))
      for (const entry of group.entries) {
        const { short, full } = entryKeys(entry);
        keys.add(short).add(full);
      }
  return keys;
}

const renderGroups = (groups: Group[]): string[] => {
  const out: string[] = [];
  for (const group of groups) {
    if (group.entries.length === 0) continue;
    if (out.length > 0) out.push("");
    if (group.heading !== null) out.push(group.heading, "");
    for (const entry of group.entries) out.push(...trimBlank(entry.lines));
  }
  return out;
};

const renderSection = (section: Section): string[] => {
  if (!section.groups) return trimBlank(section.raw);
  const body = renderGroups(section.groups);
  return body.length > 0 ? [section.heading, "", ...body] : [section.heading];
};

function renderChangelog(doc: Doc): string {
  const parts = [
    trimBlank(doc.preamble).join("\n"),
    ...doc.sections.map((s) => renderSection(s).join("\n")),
  ];
  if (doc.links.length > 0) parts.push(doc.links.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

const compareVersions = (a: string, b: string): number => {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** `https://github.com/<owner>/<repo>` from an existing compare/tag link, or null. */
const repoBase = (links: string[]): string | null => {
  for (const link of links) {
    const match = /:\s+(https?:\/\/\S+?)\/(?:compare|releases\/tag)\//.exec(link);
    if (match?.[1]) return match[1];
  }
  return null;
};

/**
 * For the entries of `groups`, the version of the first tag holding each one,
 * or null when no tag does. An entry is matched on its short key, or on its
 * whole text when another entry in `groups` shares the short key.
 */
function shippedVersion(
  groups: Group[],
  snapshots: TagSnapshot[],
): (entry: Entry) => string | null {
  const shortCount = new Map<string, number>();
  for (const group of groups)
    for (const entry of group.entries) {
      const { short } = entryKeys(entry);
      shortCount.set(short, (shortCount.get(short) ?? 0) + 1);
    }
  return (entry) => {
    const { short, full } = entryKeys(entry);
    const key = (shortCount.get(short) ?? 0) > 1 ? full : short;
    return snapshots.find((s) => s.keys.has(key))?.version ?? null;
  };
}

/** Each [Unreleased] entry a release tag already holds: its file line and that release. */
export function shippedUnreleased(
  text: string,
  snapshots: TagSnapshot[],
): Array<{ line: number; version: string }> {
  const unreleased = parseChangelog(text).sections.find(
    (s) => s.name.toLowerCase() === "unreleased",
  );
  if (!unreleased || snapshots.length === 0) return [];
  const groups = sectionGroups(unreleased);
  const shipped = shippedVersion(groups, snapshots);
  return groups.flatMap((group) =>
    group.entries.flatMap((entry) => {
      const version = shipped(entry);
      return version === null ? [] : [{ line: entry.line, version }];
    }),
  );
}

export interface RollOptions {
  /** Every release tag, oldest first, with what its CHANGELOG.md held. */
  snapshots: TagSnapshot[];
  /** The release being cut: entries no tag holds yet go to it. */
  release?: { version: string; date: string };
  tagPrefix?: string;
}

export interface RollResult {
  text: string;
  changed: boolean;
  /** Entries moved per version, newest version first. */
  moved: Array<{ version: string; entries: number }>;
}

/** Moves every [Unreleased] entry a release shipped into that release's section. */
export function rollChangelog(text: string, opts: RollOptions): RollResult {
  const prefix = opts.tagPrefix ?? TAG_PREFIX;
  const doc = parseChangelog(text);
  const unreleased = doc.sections.find((s) => s.name.toLowerCase() === "unreleased");
  if (!unreleased) return { text, changed: false, moved: [] };
  const groups = sectionGroups(unreleased);
  const shipped = shippedVersion(groups, opts.snapshots);
  const shippedIn = (entry: Entry): string | null =>
    shipped(entry) ?? opts.release?.version ?? null;

  const targets = new Map<string, Group[]>();
  const kept: Group[] = [];
  for (const group of groups) {
    const stay: Entry[] = [];
    for (const entry of group.entries) {
      const version = shippedIn(entry);
      if (version === null) {
        stay.push(entry);
        continue;
      }
      const into = targets.get(version) ?? [];
      targets.set(version, into);
      let same = into.find((g) => g.heading === group.heading);
      if (!same) {
        same = { heading: group.heading, entries: [] };
        into.push(same);
      }
      same.entries.push(entry);
    }
    kept.push({ heading: group.heading, entries: stay });
  }
  if (targets.size === 0) return { text, changed: false, moved: [] };

  unreleased.groups = kept;
  const dates = new Map(opts.snapshots.map((s) => [s.version, s.date]));
  if (opts.release) dates.set(opts.release.version, opts.release.date);
  const added: Section[] = [];
  const moved: RollResult["moved"] = [];
  for (const [version, into] of targets) {
    let section = doc.sections.find((s) => s.name === version);
    if (!section) {
      section = {
        name: version,
        heading: `## [${version}] - ${dates.get(version)}`,
        start: 0,
        raw: [],
        groups: [],
      };
      added.push(section);
    }
    const target = section.groups ?? sectionGroups(section);
    section.groups = target;
    const seen = new Set(target.flatMap((g) => g.entries.map((e) => entryKeys(e).full)));
    let count = 0;
    for (const group of into) {
      const fresh = group.entries.filter((e) => !seen.has(entryKeys(e).full));
      if (fresh.length === 0) continue;
      count += fresh.length;
      const same = target.find((g) => g.heading === group.heading);
      if (same) same.entries.push(...fresh);
      else target.push({ heading: group.heading, entries: fresh });
    }
    moved.push({ version, entries: count });
  }
  // Newest version first, after [Unreleased]; sections that are not versions
  // keep their place.
  const versioned = [...doc.sections.filter((s) => VERSION.test(s.name)), ...added].toSorted(
    (a, b) => compareVersions(b.name, a.name),
  );
  let next = 0;
  doc.sections = doc.sections.map((s) => (VERSION.test(s.name) ? versioned[next++] : s));
  doc.sections.push(...versioned.slice(next));
  doc.links = rollLinks(doc, opts, prefix);
  moved.sort((a, b) => compareVersions(b.version, a.version));
  const rolled = renderChangelog(doc);
  return { text: rolled, changed: rolled !== text, moved };
}

/** [Unreleased] compares from the newest tag; each new version links its own diff. */
function rollLinks(doc: Doc, opts: RollOptions, prefix: string): string[] {
  const base = repoBase(doc.links);
  if (base === null) return doc.links;
  const tags = opts.snapshots.map((s) => s.version);
  if (opts.release && !tags.includes(opts.release.version)) tags.push(opts.release.version);
  const named = new Map<string, string>();
  for (const link of doc.links) named.set(/^\[([^\]]+)\]/.exec(link)?.[1] ?? link, link);
  const out: string[] = [];
  const newest = tags[tags.length - 1];
  for (const section of doc.sections) {
    const existing = named.get(section.name);
    named.delete(section.name);
    if (section.name.toLowerCase() === "unreleased") {
      if (newest) out.push(`[${section.name}]: ${base}/compare/${prefix}${newest}...HEAD`);
      else if (existing) out.push(existing);
      continue;
    }
    if (existing) {
      out.push(existing);
      continue;
    }
    const at = tags.indexOf(section.name);
    if (at < 0) continue;
    const previous = tags[at - 1];
    out.push(
      previous
        ? `[${section.name}]: ${base}/compare/${prefix}${previous}...${prefix}${section.name}`
        : `[${section.name}]: ${base}/releases/tag/${prefix}${section.name}`,
    );
  }
  return [...out, ...named.values()];
}

/** The groups of a version's section, or [] when CHANGELOG.md has none. */
export function versionGroups(text: string, version: string): Group[] {
  const section = parseChangelog(text).sections.find((s) => s.name === version);
  return section ? sectionGroups(section).filter((g) => g.entries.length > 0) : [];
}

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

/** Every `<prefix><x.y.z>` tag, oldest version first, with its CHANGELOG.md keys. */
export function tagSnapshots(
  exec: Exec,
  prefix = TAG_PREFIX,
  file = "CHANGELOG.md",
): TagSnapshot[] {
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+\\.\\d+\\.\\d+)$`,
  );
  const rows = exec("git", [
    "for-each-ref",
    "--format=%(refname:short)%09%(creatordate:short)",
    `refs/tags/${prefix}*`,
  ])
    .split("\n")
    .map((row) => row.trim().split("\t"))
    .flatMap(([tag = "", date = ""]) => {
      const version = pattern.exec(tag)?.[1];
      return version ? [{ tag, version, date }] : [];
    })
    .toSorted((a, b) => compareVersions(a.version, b.version));
  return rows.map((row) => {
    let text = "";
    try {
      text = exec("git", ["show", `${row.tag}:${file}`]);
    } catch {
      // A tag from before the file existed holds no entries.
    }
    return { ...row, keys: changelogKeys(text) };
  });
}

const today = (): string => new Date().toISOString().slice(0, 10);

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** The CLI; returns the exit code. */
export function main(
  args: string[],
  io: { root: string; exec?: Exec; out: (s: string) => void; err: (s: string) => void },
): number {
  const notes = flag(args, "--notes");
  const release = flag(args, "--release") ?? notes;
  const date = flag(args, "--date") ?? today();
  if (release !== undefined && !VERSION.test(release)) {
    io.err(`not a release version: ${JSON.stringify(release)}`);
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
