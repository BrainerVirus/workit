// User-facing release notes for `workit release finish` and `workit release
// notes`: pure functions from a version's Keep a Changelog section to the
// forge release body.
//
//   ## Highlights        1-3 bullets the agent writes in the draft (omitted when empty)
//   ## Breaking changes  bullets of the Removed section and any marked BREAKING
//   ## Changes           the version's ### Added/Changed/Deprecated/Removed/Fixed/Security
//   **Full changelog**: <compare previous-tag...tag>

/** Keep a Changelog's sections, in its order. */
export const KEEP_A_CHANGELOG_SECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

type Subsection = { heading: string | null; body: string };

/** A changelog section split at its `###` headings; text before the first one has no heading. */
export function changelogSubsections(section: string): Subsection[] {
  const parts: Subsection[] = [];
  let current: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };
  const close = () => {
    const body = current.lines.join("\n").trim();
    if (body) parts.push({ heading: current.heading, body });
  };
  for (const line of section.split(/\r?\n/u)) {
    const heading = /^###\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      close();
      current = { heading: heading[1], lines: [] };
    } else current.lines.push(line);
  }
  close();
  return parts;
}

type SectionName = (typeof KEEP_A_CHANGELOG_SECTIONS)[number];

const canonical = (heading: string): SectionName | null =>
  KEEP_A_CHANGELOG_SECTIONS.find((name) => name.toLowerCase() === heading.trim().toLowerCase()) ??
  null;

/** Top-level list items of a Markdown body, each with its indented continuation lines. */
export function listItems(body: string): string[] {
  const items: string[][] = [];
  let open: string[] | null = null;
  for (const line of body.split(/\r?\n/u)) {
    if (/^[-*+]\s+/u.test(line)) {
      open = [line];
      items.push(open);
    } else if (open && /^\s+\S/u.test(line)) open.push(line);
    else open = null;
  }
  return items.map((lines) => lines.join("\n").trimEnd());
}

const BREAKING = /\bBREAKING\b/u;

/** The breaking changes: every item of a Removed section, and any item marked BREAKING. */
export function breakingChanges(section: string): string[] {
  const found: string[] = [];
  for (const part of changelogSubsections(section)) {
    const removed = part.heading !== null && canonical(part.heading) === "Removed";
    for (const item of listItems(part.body))
      if ((removed || BREAKING.test(item)) && !found.includes(item)) found.push(item);
  }
  return found;
}

/**
 * The `## Changes` body: the Keep a Changelog sections in their order, then
 * any other heading in the order written; text before the first heading leads.
 */
export function changesBody(section: string): string {
  const parts = changelogSubsections(section);
  const rank = (part: Subsection): number => {
    if (part.heading === null) return -1;
    const name = canonical(part.heading);
    return name ? KEEP_A_CHANGELOG_SECTIONS.indexOf(name) : KEEP_A_CHANGELOG_SECTIONS.length;
  };
  return parts
    .map((part, index) => ({ part, index }))
    .toSorted((a, b) => rank(a.part) - rank(b.part) || a.index - b.index)
    .map(({ part }) =>
      part.heading === null
        ? part.body
        : `### ${canonical(part.heading) ?? part.heading}\n\n${part.body}`,
    )
    .join("\n\n");
}

/** The body of a draft's `## Highlights` section, or null when it has none or it is empty. */
export function highlightsOf(notes: string): string | null {
  const lines = notes.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+Highlights\s*$/iu.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/u.test(line));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return body || null;
}

export type ForgeKindName = "github" | "gitlab";

/** The forge's compare page from `from` to `to`: GitHub `/compare/a...b`, GitLab `/-/compare/a...b`. */
export const compareUrl = (
  kind: ForgeKindName,
  webBase: string,
  from: string,
  to: string,
): string =>
  `${webBase.replace(/\/+$/u, "")}${kind === "gitlab" ? "/-/compare/" : "/compare/"}${encodeURI(from)}...${encodeURI(to)}`;

type ParsedVersion = { main: string[]; pre: string[] };

const parseVersion = (version: string): ParsedVersion | null => {
  if (!/^\d/u.test(version)) return null;
  const core = version.split("+")[0];
  const dash = core.indexOf("-");
  const main = (dash < 0 ? core : core.slice(0, dash)).split(".");
  const pre = dash < 0 ? [] : core.slice(dash + 1).split(".");
  return { main, pre };
};

const compareIdentifier = (a: string, b: string): number => {
  const numeric = /^\d+$/u;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Semver-like ordering: numeric parts compare as numbers, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
  for (let index = 0; index < Math.max(left.main.length, right.main.length); index += 1) {
    const diff = compareIdentifier(left.main[index] ?? "0", right.main[index] ?? "0");
    if (diff) return diff;
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const diff = compareIdentifier(left.pre[index], right.pre[index]);
    if (diff) return diff;
  }
  return 0;
}

/**
 * The latest tag before `version` with the same prefix (`v1.3.0` before
 * `v1.4.0`; `api/v2.0.0` only among `api/v*`), or null when there is none.
 */
export function previousTag(tags: string[], prefix: string, version: string): string | null {
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const candidate = tag.slice(prefix.length);
    if (!parseVersion(candidate) || compareVersions(candidate, version) >= 0) continue;
    if (!best || compareVersions(candidate, best.version) > 0) best = { tag, version: candidate };
  }
  return best?.tag ?? null;
}

/** The release notes Markdown: Highlights, Breaking changes, Changes, Full changelog. */
export function renderReleaseNotes(input: {
  version: string;
  /** The version's changelog section, or null without one. */
  changelog: string | null;
  /** The Highlights body (bullets), or null to omit the section. */
  highlights?: string | null;
  /** The compare link, or null without a previous tag or a known forge. */
  compare?: string | null;
}): string {
  const blocks: string[] = [];
  const highlights = input.highlights?.trim();
  if (highlights) blocks.push(`## Highlights\n\n${highlights}`);
  const section = input.changelog?.trim() ?? "";
  const breaking = section ? breakingChanges(section) : [];
  if (breaking.length) blocks.push(`## Breaking changes\n\n${breaking.join("\n")}`);
  const changes = section ? changesBody(section) : "";
  if (changes) blocks.push(`## Changes\n\n${changes}`);
  if (!blocks.length) blocks.push(`Release ${input.version}`);
  if (input.compare) blocks.push(`**Full changelog**: ${input.compare}`);
  return `${blocks.join("\n\n")}\n`;
}
