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
