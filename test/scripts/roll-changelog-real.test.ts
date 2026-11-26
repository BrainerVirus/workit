// Regressions on the repository's own CHANGELOG.md: a roll of an already
// rolled file changes nothing, rolling the entries back out of [Unreleased]
// loses no line (multi-line bullets, `### Changed (note)` groups), and a file a
// merge doubled (entries back under [Unreleased] that their release's section
// already holds) is refused, never rewritten. Tags are faked from the file's
// own version sections, so no git history is needed.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Exec,
  lostLines,
  parseChangelog,
  rollChangelog,
  runChangelogRoll,
  versionGroups,
} from "@/packages/workit-core/src/core/changelog-roll";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

const REAL = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
const PREFIX = "workit-dev-v";

const doc = parseChangelog(REAL);
/** The @workit-dev releases the file has sections for, oldest first. */
const RELEASES = doc.sections
  .filter((s) => /^(?:[1-9]\d*)\.\d+\.\d+$/.test(s.name))
  .map((s) => s.name)
  .toReversed();
const lines = REAL.split("\n");
const sectionText = (name: string): string => {
  const at = doc.sections.findIndex((s) => s.name === name);
  const next = doc.sections[at + 1];
  return lines.slice(doc.sections[at]?.start, next?.start).join("\n");
};

/** git for a repo whose tag `<prefix><v>` holds every section up to `v`. */
const fakeGit: Exec = (cmd, args) => {
  if (cmd !== "git") throw new Error(`unexpected ${cmd}`);
  if (args[0] === "for-each-ref")
    return RELEASES.map((v) => `${PREFIX}${v}\t2026-11-18`).join("\n");
  const version = /^workit-dev-v(.+):(?:\.\/)?CHANGELOG\.md$/.exec(args[1] ?? "")?.[1] ?? "";
  const upTo = RELEASES.slice(0, RELEASES.indexOf(version) + 1);
  return `# Changelog\n\n## [Unreleased]\n\n${upTo.map(sectionText).join("\n\n")}\n`;
};

const entryTexts = (text: string, version: string): string[] =>
  versionGroups(text, version)
    .flatMap((g) => g.entries.map((e) => `${g.heading}|${e.lines.join("\n").trimEnd()}`))
    .toSorted();

/** The file as it was before any roll: every release's groups back under [Unreleased]. */
function unrolled(): string {
  const released = new Set(RELEASES);
  const kept = doc.sections.filter((s) => !released.has(s.name));
  // Up to the end of [Unreleased], then the moved groups, then 0.x and the links.
  const head = lines.slice(0, doc.sections[1]?.start).join("\n").trimEnd();
  const moved = RELEASES.toReversed()
    .map((v) => sectionText(v).split("\n").slice(1).join("\n").trim())
    .join("\n\n");
  const tail = lines.slice(kept[1]?.start).join("\n");
  return `${head}\n\n${moved}\n\n${tail}`;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const checkoutWith = (text: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-roll-real-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "CHANGELOG.md"), text);
  return dir;
};
/** `workit changelog roll` (or `release <version>`) in `dir`, as core runs it. */
const run = (dir: string, release?: { version: string; date: string }) => {
  const result = runChangelogRoll({
    cwd: dir,
    tagPrefix: PREFIX,
    write: true,
    exec: fakeGit,
    ...(release ? { release } : {}),
  });
  return {
    code: result.ok ? 0 : 1,
    err: result.ok ? "" : [result.error, ...result.lines].join("\n"),
    text: readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
  };
};

test("the real CHANGELOG.md has @workit-dev release sections to roll", () => {
  expect(RELEASES.length).toBeGreaterThan(50);
  expect(RELEASES[0]).toBe("1.0.0");
});

test("Given the real, already rolled CHANGELOG.md, When it is rolled twice, Then neither roll changes a byte", () => {
  const dir = checkoutWith(REAL);
  expect(run(dir).text).toBe(REAL);
  expect(run(dir).text).toBe(REAL);
});

test("Given the real entries back under [Unreleased], When rolled, Then every release gets exactly its entries and no line is lost", () => {
  const before = unrolled();
  expect(before).not.toBe(REAL);
  const dir = checkoutWith(before);
  const { code, text } = run(dir);
  expect(code).toBe(0);
  expect(lostLines(before, text)).toEqual([]);
  for (const version of RELEASES)
    expect(entryTexts(text, version)).toEqual(entryTexts(REAL, version));
  // Rolling the result again is a no-op.
  expect(run(dir).text).toBe(text);
});

test("Given a merge that put released entries back under [Unreleased] (the rebase shape), When rolled, Then it refuses with exit 1 and writes nothing", () => {
  const latest = RELEASES.at(-1) ?? "";
  const doubled = REAL.replace(
    "## [Unreleased]\n",
    `## [Unreleased]\n\n${sectionText(latest).split("\n").slice(1).join("\n").trim()}\n`,
  );
  const dir = checkoutWith(doubled);
  const { code, err, text } = run(dir);
  expect(code).toBe(1);
  expect(err).toContain("CHANGELOG.md: not rolled.");
  expect(err).toContain(`is already under [${latest}]`);
  expect(text).toBe(doubled);
});

test("The line guard catches a dropped continuation line and ignores headings a roll merges", () => {
  const before =
    "## [Unreleased]\n\n### Changed (retro 2026-11-17)\n\n- **Bold.** First\n  second line.\n";
  expect(
    lostLines(before, "## [Unreleased]\n\n### Changed (retro 2026-11-17)\n\n- **Bold.** First\n"),
  ).toEqual(["  second line."]);
  // A group heading that merges into a version's same-named group is structure, not text.
  expect(lostLines(before, "## [Unreleased]\n\n- **Bold.** First\n  second line.\n")).toEqual([]);
  // Moving lines into a new section and rewriting link definitions loses nothing.
  const rolled = rollChangelog(
    `${before}\n[Unreleased]: https://github.com/acme/w/compare/a...HEAD\n`,
    {
      snapshots: [],
      release: { version: "1.0.1", date: "2026-01-02" },
      tagPrefix: PREFIX,
    },
  );
  expect(lostLines(before, rolled.text)).toEqual([]);
  expect(rolled.text).toContain(
    "## [1.0.1] - 2026-01-02\n\n### Changed (retro 2026-11-17)\n\n- **Bold.** First\n  second line.",
  );
});

/** The real file with [1.14.0]'s second `### Fixed` entry moved under a new [Unreleased] `### Fixed`. */
function fixedEntryBackInUnreleased(): { text: string; entry: string } {
  const fixed = versionGroups(REAL, "1.14.0").find((g) => g.heading === "### Fixed");
  const entry = fixed?.entries[1]?.lines.join("\n") ?? "";
  expect(entry).toStartWith("- ");
  expect(REAL.split(`${entry}\n`)).toHaveLength(2);
  const text = REAL.replace(`${entry}\n`, "").replace(
    "## [Unreleased]\n",
    `## [Unreleased]\n\n### Fixed\n\n${entry}\n`,
  );
  return { text, entry };
}

/** The [Unreleased] section of `text`: it may hold the branch's own, really unreleased entries. */
const unreleasedOf = (text: string): string => {
  const { sections } = parseChangelog(text);
  const at = sections.findIndex((s) => s.name === "Unreleased");
  return text
    .split("\n")
    .slice(sections[at]?.start, sections[at + 1]?.start)
    .join("\n");
};

test("Given an [Unreleased] entry whose release already has its group, When rolled, Then it joins that group and the roll succeeds", () => {
  const { text, entry } = fixedEntryBackInUnreleased();
  const dir = checkoutWith(text);
  const { code, err, text: rolled } = run(dir);
  expect(err).not.toContain("not rolled");
  expect(code).toBe(0);
  expect(lostLines(text, rolled)).toEqual([]);
  const fixed = versionGroups(rolled, "1.14.0").find((g) => g.heading === "### Fixed");
  expect(fixed?.entries.map((e) => e.lines.join("\n"))).toContain(entry);
  expect(unreleasedOf(text)).toContain(entry);
  expect(unreleasedOf(rolled)).not.toContain(entry);
});

test("Given that same file, When the release prepare runs, Then it succeeds and files the entry under its release, not the new one", () => {
  const { text, entry } = fixedEntryBackInUnreleased();
  const dir = checkoutWith(text);
  const { code, text: rolled } = run(dir, { version: "9.9.9", date: "2026-11-19" });
  expect(code).toBe(0);
  expect(
    versionGroups(rolled, "1.14.0").flatMap((g) => g.entries.map((e) => e.lines.join("\n"))),
  ).toContain(entry);
  expect(
    versionGroups(rolled, "9.9.9").flatMap((g) => g.entries.map((e) => e.lines.join("\n"))),
  ).not.toContain(entry);
  expect(unreleasedOf(rolled)).not.toContain(entry);
});
