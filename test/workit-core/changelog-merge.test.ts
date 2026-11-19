import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeChangelogFiles,
  mergeUnreleasedBody,
} from "@/packages/workit-core/src/core/changelog-merge";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const file = (changelog: string, name: string, dir: string) => {
  const target = path.join(dir, name);
  writeFileSync(target, changelog);
  return target;
};

const doc = (unreleased: string, released = "- first\n") => `# Changelog

## [Unreleased]

${unreleased}## [1.0.0] - 2026-01-01

### Added

${released}`;

const BASE = doc("### Added\n\n- base\n\n");

const merge = (base: string, ours: string, theirs: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-clmerge-"));
  dirs.push(dir);
  const files = {
    base: file(base, "base", dir),
    ours: file(ours, "ours", dir),
    theirs: file(theirs, "theirs", dir),
  };
  const result = mergeChangelogFiles(files);
  return { ...result, text: readFileSync(files.ours, "utf8") };
};

test("Given both sides add bullets under Added and Fixed, Then each heading appears once with every bullet and the merge is clean", () => {
  const ours = doc("### Added\n\n- ours add\n- base\n\n### Fixed\n\n- ours fix\n\n");
  const theirs = doc("### Added\n\n- theirs add\n- base\n\n### Fixed\n\n- theirs fix\n\n");
  const { code, text } = merge(BASE, ours, theirs);
  expect(code).toBe(0);
  expect(text.match(/### Added/g)).toHaveLength(2);
  expect(text.match(/### Fixed/g)).toHaveLength(1);
  const unreleased = text.split("## [1.0.0]")[0];
  expect(unreleased).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ours add\n- base\n- theirs add\n\n### Fixed\n\n- ours fix\n- theirs fix\n\n",
  );
});

test("Given both sides add the same bullet, Then it appears once", () => {
  const ours = doc("### Added\n\n- same\n- base\n\n");
  const theirs = doc("### Added\n\n- same\n- base\n- other\n\n");
  const { text } = merge(BASE, ours, theirs);
  expect(text.match(/- same/g)).toHaveLength(1);
  expect(text).toContain("- other");
});

test("Given theirs adds a heading ours lacks, Then it is appended after ours' headings", () => {
  const ours = doc("### Added\n\n- ours\n- base\n\n");
  const theirs = doc("### Added\n\n- base\n\n### Security\n\n- patch\n\n");
  const { code, text } = merge(BASE, ours, theirs);
  expect(code).toBe(0);
  expect(text.indexOf("### Added")).toBeLessThan(text.indexOf("### Security"));
  expect(text).toContain("- ours");
});

test("Given one side removed a bullet from base, Then it stays removed", () => {
  const ours = doc("### Added\n\n- new\n\n");
  const theirs = doc("### Added\n\n- base\n- extra\n\n");
  const { text } = merge(BASE, ours, theirs);
  expect(text).not.toContain("- base");
  expect(text).toContain("- new");
  expect(text).toContain("- extra");
});

test("Given both sides edit a released section differently, Then the merge conflicts with git's markers and loses nothing", () => {
  const ours = doc("### Added\n\n- base\n- ours\n\n", "- ours edit\n");
  const theirs = doc("### Added\n\n- base\n- theirs\n\n", "- theirs edit\n");
  const { code, text } = merge(BASE, ours, theirs);
  expect(code).toBe(1);
  expect(text).toContain("<<<<<<< ours");
  expect(text).toContain("- ours edit");
  expect(text).toContain("- theirs edit");
  expect(text).toContain("- ours\n");
  expect(text).toContain("- theirs\n");
});

test("Given a side with an unchanged Unreleased body, Then the other side's body is taken verbatim", () => {
  expect(mergeUnreleasedBody("\n### Added\n\n- a\n", "\n### Added\n\n- a\n", "x")).toBe("x");
});

const crlf = (text: string) => text.replace(/\n/g, "\r\n");

test("Given a CRLF changelog where both sides add bullets, Then every line ending in the merge is CRLF", () => {
  const ours = crlf(doc("### Added\n\n- ours add\n- base\n\n### Fixed\n\n- ours fix\n\n"));
  const theirs = crlf(doc("### Added\n\n- theirs add\n- base\n\n### Security\n\n- theirs sec\n\n"));
  const { code, text } = merge(crlf(BASE), ours, theirs);
  expect(code).toBe(0);
  expect(text).toContain("- theirs sec");
  expect(text.replace(/\r\n/g, "")).not.toContain("\n");
});

test("Given an LF changelog, Then the merge has no CR", () => {
  const ours = doc("### Added\n\n- ours add\n- base\n\n");
  const theirs = doc("### Added\n\n- theirs add\n- base\n\n");
  expect(merge(BASE, ours, theirs).text).not.toContain("\r");
});

// A roll: `## [Unreleased]` entries moved into a `## [1.2.0]` section above 1.0.0.
const rolled = (unreleased: string, moved: string) => `# Changelog

## [Unreleased]

${unreleased}## [1.2.0] - 2026-02-01

### Added

${moved}
## [1.0.0] - 2026-01-01

### Added

- first
`;

const unreleasedOf = (text: string) => text.split(/^## \[1\.[02]\.0\]/mu)[0];

test("Given ours moved Unreleased entries into 1.2.0 and theirs still lists them plus a new one, When the driver merges, Then Unreleased holds only the new entry and 1.2.0 keeps its entries once", () => {
  const base = doc("### Added\n\n- alpha\n- beta\n\n");
  const ours = rolled("", "- alpha\n- beta\n");
  const theirs = doc("### Added\n\n- alpha\n- beta\n- gamma\n\n");
  const { code, text } = merge(base, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- gamma\n\n");
  expect(text.match(/- alpha/g)).toHaveLength(1);
  expect(text.match(/- beta/g)).toHaveLength(1);
  expect(text).toContain("## [1.2.0] - 2026-02-01\n\n### Added\n\n- alpha\n- beta\n");
});

test("Given a rebase replays a roll onto a main that still lists the rolled entries plus a new one, Then Unreleased holds only the new entry", () => {
  // Rebase: ours is the upstream (main), theirs the replayed roll commit, base its parent.
  const base = doc("### Added\n\n- alpha\n- beta\n\n### Fixed\n\n- delta\n\n");
  const ours = doc("### Added\n\n- alpha\n- beta\n- gamma\n\n### Fixed\n\n- delta\n\n");
  const theirs = rolled("", "- alpha\n- beta\n\n### Fixed\n\n- delta\n");
  const { code, text } = merge(base, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- gamma\n\n");
  for (const entry of ["alpha", "beta", "delta", "gamma"])
    expect(text.match(new RegExp(`- ${entry}\\n`, "gu"))).toHaveLength(1);
});

test("Given theirs re-adds an entry that a released section of either side already holds, Then it is not put back under Unreleased", () => {
  // No base copy to show the move: only the released section tells.
  const base = doc("");
  const ours = rolled("### Added\n\n- ours new\n\n", "- alpha\n");
  const theirs = doc("### Added\n\n- alpha\n- theirs new\n\n");
  const { code, text } = merge(base, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ours new\n- theirs new\n\n",
  );
  expect(text.match(/- alpha/g)).toHaveLength(1);
});

test("Given entries only in Unreleased on both sides, Then both sides' entries are kept", () => {
  const ours = doc("### Added\n\n- base\n- ours only\n\n");
  const theirs = doc("### Added\n\n- base\n- theirs only\n\n");
  const { code, text } = merge(BASE, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- base\n- ours only\n- theirs only\n\n",
  );
});

test("Given a new Unreleased entry whose first line repeats an entry of a release older than the base, Then the merge keeps it", () => {
  const base = doc("", "- Dependencies bumped.\n");
  const ours = doc("### Added\n\n- ours new\n\n", "- Dependencies bumped.\n");
  const theirs = doc("### Added\n\n- Dependencies bumped.\n\n", "- Dependencies bumped.\n");
  const { code, text } = merge(base, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ours new\n- Dependencies bumped.\n\n",
  );
});

test("Given ours is unchanged and theirs adds an entry that repeats an old release's entry, Then theirs is taken with it", () => {
  const base = doc("", "- Dependencies bumped.\n");
  const theirs = doc("### Added\n\n- Dependencies bumped.\n\n", "- Dependencies bumped.\n");
  const { code, text } = merge(base, base, theirs);
  expect(code).toBe(0);
  expect(text).toBe(theirs);
});

test("Given a multi-line Docs bullet adds a sub-item under an old release's Docs bullet, Then the new bullet survives the merge", () => {
  const old = "- Docs:\n  - old guide\n";
  const base = doc("", old);
  const ours = doc("### Added\n\n- ours new\n\n", old);
  const theirs = doc("### Added\n\n- Docs:\n  - new guide\n\n", old);
  const { code, text } = merge(base, ours, theirs);
  expect(code).toBe(0);
  expect(unreleasedOf(text)).toBe(
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- ours new\n- Docs:\n  - new guide\n\n",
  );
});

test("Given the issue's roll in either direction, Then Unreleased holds only gamma", () => {
  const base = doc("### Added\n\n- alpha\n- beta\n\n");
  const roll = rolled("", "- alpha\n- beta\n");
  const added = doc("### Added\n\n- alpha\n- beta\n- gamma\n\n");
  for (const [ours, theirs] of [
    [roll, added],
    [added, roll],
  ]) {
    const { code, text } = merge(base, ours, theirs);
    expect(code).toBe(0);
    expect(unreleasedOf(text)).toBe("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- gamma\n\n");
    expect(text.match(/- alpha/g)).toHaveLength(1);
  }
});
