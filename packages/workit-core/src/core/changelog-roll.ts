// Moves CHANGELOG.md entries out of `## [Unreleased]` into the release that
// shipped them (`workit changelog roll`), and cuts a release from the rest
// (`workit changelog release <version>`).
//
// An entry (a top-level bullet with its continuation lines) belongs to the
// first `<prefix><x.y.z>` tag whose changelog already holds it, so the result
// depends only on the tags, never on when the file was last rolled. Only the
// file and local git (`for-each-ref`, `show`) are read: no forge, no grant.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, releaseLinesOf } from "../git/ops";

/** Runs a command and returns its stdout; throws on a non-zero exit. */
export type Exec = (cmd: string, args: string[], input?: string) => string;

/** One bullet with its continuation lines (no trailing newline). */
export interface Entry {
  lines: string[];
  /** 1-based line of the bullet in the file it was parsed from (0 when built). */
  line: number;
}

/** A `###` group (or the lines before the first one, heading null). */
export interface Group {
  heading: string | null;
  entries: Entry[];
  /** Rendered even with no entries: it had none before the roll touched it. */
  keep?: boolean;
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

/** What a tag's changelog held, for attributing entries to releases. */
export interface TagSnapshot {
  tag: string;
  version: string;
  /** YYYY-MM-DD the tag was made. */
  date: string;
  keys: Set<string>;
}

const SECTION = /^##\s+\[([^\]]+)\]/;
const GROUP = /^###\s+/;
const BULLET = /^[-*]\s+/;
const LINK = /^\[[^\]]+\]:\s+\S/;
const HEADING = /^#{2,3}\s/;
/** A release version this roll orders and attributes: `x.y.z`. */
export const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const KEY_LENGTH = 100;

export const trimBlank = (lines: string[]): string[] => {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out;
};

const isUnreleased = (section: Section): boolean => section.name.toLowerCase() === "unreleased";

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
const entryKeys = (entry: Entry): { short: string; full: string } => {
  const full = collapse(entry);
  return { short: full.slice(0, KEY_LENGTH), full };
};

/** Every short and full key of every bullet in a changelog, any section. */
function changelogKeys(text: string): Set<string> {
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

/** The Markdown lines of `groups`: each `###` heading once, then its bullets. */
export const renderGroups = (groups: Group[]): string[] => {
  const out: string[] = [];
  for (const group of groups) {
    if (group.entries.length === 0 && !(group.keep && group.heading !== null)) continue;
    if (out.length > 0) out.push("");
    if (group.heading !== null) out.push(group.heading, ...(group.entries.length ? [""] : []));
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

export const compareVersions = (a: string, b: string): number => {
  const x = RELEASE_VERSION.exec(a);
  const y = RELEASE_VERSION.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** `https://github.com/<owner>/<repo>` from an existing compare/tag link, or null. */
export const repoBase = (links: string[]): string | null => {
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
  const unreleased = parseChangelog(text).sections.find(isUnreleased);
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
  /** Every release tag, oldest first, with what its changelog held. */
  snapshots: TagSnapshot[];
  /** The release being cut: entries no tag holds yet go to it. */
  release?: { version: string; date: string };
  /** The tags' prefix, for the compare links of new sections. */
  tagPrefix: string;
}

export interface RollResult {
  text: string;
  changed: boolean;
  /** Entries moved per version, newest version first. */
  moved: Array<{ version: string; entries: number }>;
  /**
   * [Unreleased] entries whose version's section already holds the same text
   * (a merge that put back what a roll moved). The roll still moves them, so
   * the text would appear twice; callers refuse to write it.
   */
  duplicates: Array<{ version: string; line: number }>;
}

const contentLines = (text: string): string[] =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "" && !LINK.test(line) && !HEADING.test(line));

/**
 * The non-blank lines of `before` that `after` holds fewer times. Link
 * definitions and `##`/`###` headings are left out: a roll rewrites links, and
 * merges an emptied [Unreleased] group into the same-named group of a version
 * section, so a heading can legitimately appear fewer times. Every entry and
 * continuation line counts, so any line here means the roll lost text.
 */
export function lostLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const line of contentLines(after)) left.set(line, (left.get(line) ?? 0) + 1);
  const lost: string[] = [];
  for (const line of contentLines(before)) {
    const n = left.get(line) ?? 0;
    if (n === 0) lost.push(line);
    else left.set(line, n - 1);
  }
  return lost;
}

/** Moves every [Unreleased] entry a release shipped into that release's section. */
export function rollChangelog(text: string, opts: RollOptions): RollResult {
  const doc = parseChangelog(text);
  const unreleased = doc.sections.find(isUnreleased);
  if (!unreleased) return { text, changed: false, moved: [], duplicates: [] };
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
    kept.push({ heading: group.heading, entries: stay, keep: group.entries.length === 0 });
  }
  if (targets.size === 0) return { text, changed: false, moved: [], duplicates: [] };

  unreleased.groups = kept;
  const dates = new Map(opts.snapshots.map((s) => [s.version, s.date]));
  if (opts.release) dates.set(opts.release.version, opts.release.date);
  const added: Section[] = [];
  const moved: RollResult["moved"] = [];
  const duplicates: RollResult["duplicates"] = [];
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
      for (const entry of group.entries)
        if (seen.has(entryKeys(entry).full)) duplicates.push({ version, line: entry.line });
      count += group.entries.length;
      const same = target.find((g) => g.heading === group.heading);
      if (same) same.entries.push(...group.entries);
      else target.push({ heading: group.heading, entries: [...group.entries] });
    }
    moved.push({ version, entries: count });
  }
  // Newest version first, after [Unreleased]; sections that are not versions
  // keep their place.
  const isVersion = (s: Section): boolean => RELEASE_VERSION.test(s.name);
  const versioned = [...doc.sections.filter(isVersion), ...added].toSorted((a, b) =>
    compareVersions(b.name, a.name),
  );
  let next = 0;
  doc.sections = doc.sections.map((s) => (isVersion(s) ? (versioned[next++] ?? s) : s));
  doc.sections.push(...versioned.slice(next));
  doc.links = rollLinks(doc, opts);
  moved.sort((a, b) => compareVersions(b.version, a.version));
  const rolled = renderChangelog(doc);
  return { text: rolled, changed: rolled !== text, moved, duplicates };
}

/** [Unreleased] compares from the newest tag; each new version links its own diff. */
function rollLinks(doc: Doc, opts: RollOptions): string[] {
  const prefix = opts.tagPrefix;
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
    if (isUnreleased(section)) {
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

/** The groups of a version's section, or [] when the changelog has none. */
export function versionGroups(text: string, version: string): Group[] {
  const section = parseChangelog(text).sections.find((s) => s.name === version);
  return section ? sectionGroups(section).filter((g) => g.entries.length > 0) : [];
}

/** A version's entries as release-notes Markdown (`### Fixed`, then its bullets); "" without any. */
export function versionNotes(text: string, version: string): string {
  const lines = renderGroups(versionGroups(text, version));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Every `<prefix><x.y.z>` tag, oldest version first, with its changelog's keys at `<tag>:<file>`. */
export function tagSnapshots(exec: Exec, prefix: string, file = "CHANGELOG.md"): TagSnapshot[] {
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

/** Why a roll was not written: entries it would double, or lines it would drop. */
export type RollRefusal =
  | { kind: "duplicates"; duplicates: RollResult["duplicates"] }
  | { kind: "lost"; lines: string[] };

/** The refusal that keeps `rolled` from replacing `before`, or null when it is safe to write. */
export function rollRefusal(before: string, rolled: RollResult): RollRefusal | null {
  if (rolled.duplicates.length > 0) return { kind: "duplicates", duplicates: rolled.duplicates };
  const lines = lostLines(before, rolled.text);
  return lines.length > 0 ? { kind: "lost", lines } : null;
}

/** The lines that explain `refusal` for the changelog at `file` (at most 20 items listed). */
export function refusalLines(file: string, refusal: RollRefusal): string[] {
  if (refusal.kind === "duplicates")
    return [
      `${file}: not rolled. ${refusal.duplicates.length} [Unreleased] entries are already in their release's section (a merge put back what a roll moved): delete them from [Unreleased], then rerun.`,
      ...refusal.duplicates
        .slice(0, 20)
        .map(({ version, line }) => `  ${file}:${line} is already under [${version}]`),
    ];
  return [
    `${file}: not rolled. The roll would drop ${refusal.lines.length} line(s), so nothing was written:`,
    ...refusal.lines.slice(0, 20).map((line) => `  ${line}`),
  ];
}

/** The repo's release tag prefix (its first release line's), `v` when it cannot be read. */
export function defaultTagPrefix(cwd: string): string {
  try {
    return releaseLinesOf(cwd)[0]?.tagPrefix ?? "v";
  } catch {
    return "v";
  }
}

/** git in `cwd` as an Exec: stdout, or a throw on a non-zero exit. */
export const gitExec =
  (cwd: string): Exec =>
  (cmd, args) => {
    if (cmd !== "git") throw new Error(`not a git command: ${cmd}`);
    const run = git(cwd, args);
    if (!run.ok) throw new Error(run.stderr.trim() || `git ${args[0]} failed`);
    return run.stdout;
  };

export interface ChangelogRollInput {
  cwd: string;
  /** The changelog, relative to `cwd` (default `CHANGELOG.md`). */
  path?: string;
  /** Default: the repo's release tag prefix. */
  tagPrefix?: string;
  /** Cut this release: every entry no tag holds goes into `## [<version>] - <date>`. */
  release?: { version: string; date: string };
  /** False: compute the result and its notes, write nothing. */
  write: boolean;
  exec?: Exec;
}

export type ChangelogRollRun =
  | {
      ok: true;
      /** The changelog as given (relative to `cwd`). */
      path: string;
      tagPrefix: string;
      /** How many release tags were read. */
      tags: number;
      changed: boolean;
      written: boolean;
      moved: RollResult["moved"];
      /** The rolled text (what was or would be written). */
      text: string;
      /** The release's entries as Markdown; "" without a release or without entries. */
      notes: string;
      warnings: string[];
    }
  | { ok: false; code: "not_found" | "refused"; path: string; error: string; lines: string[] };

/** Rolls (and with `release`, releases) the changelog at `input.path`, writing only a safe result. */
export function runChangelogRoll(input: ChangelogRollInput): ChangelogRollRun {
  const rel = input.path ?? "CHANGELOG.md";
  const file = path.resolve(input.cwd, rel);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {
      ok: false,
      code: "not_found",
      path: rel,
      error: `${rel}: no such changelog`,
      lines: [],
    };
  }
  const tagPrefix = input.tagPrefix ?? defaultTagPrefix(input.cwd);
  const exec = input.exec ?? gitExec(input.cwd);
  const warnings: string[] = [];
  // `<tag>:./<path>` is relative to the cwd, so a changelog below the repo root reads too.
  const atTag = `./${path.relative(input.cwd, file).split(path.sep).join("/")}`;
  let snapshots: TagSnapshot[] = [];
  try {
    snapshots = tagSnapshots(exec, tagPrefix, atTag);
  } catch (error) {
    warnings.push(
      `could not read the ${tagPrefix}* tags (${error instanceof Error ? error.message.split("\n")[0] : String(error)}): every [Unreleased] entry counts as unreleased`,
    );
  }
  const rolled = rollChangelog(text, {
    snapshots,
    tagPrefix,
    ...(input.release ? { release: input.release } : {}),
  });
  if (snapshots.length === 0 && warnings.length === 0 && rolled.moved.length > 0)
    warnings.push(
      `no ${tagPrefix}<x.y.z> tags here, so no entry counts as released before ${input.release?.version}; in CI fetch the tags first (actions/checkout with fetch-depth: 0, or git fetch --tags)`,
    );
  const refusal = rolled.changed ? rollRefusal(text, rolled) : null;
  if (refusal)
    return {
      ok: false,
      code: "refused",
      path: rel,
      error: refusalLines(rel, refusal)[0] ?? "",
      lines: refusalLines(rel, refusal).slice(1),
    };
  const written = rolled.changed && input.write;
  if (written)
    writeFileSync(
      file,
      text.includes("\r\n") ? rolled.text.replace(/\n/g, "\r\n") : rolled.text,
      "utf8",
    );
  return {
    ok: true,
    path: rel,
    tagPrefix,
    tags: snapshots.length,
    changed: rolled.changed,
    written,
    moved: rolled.moved,
    text: rolled.text,
    notes: input.release ? versionNotes(rolled.text, input.release.version) : "",
    warnings,
  };
}
