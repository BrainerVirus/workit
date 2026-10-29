import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { generateNotes } from "@semantic-release/release-notes-generator";

// The release notes writer must list every commit type that can trigger a
// release. analyze-release-scope releases on any product-path change, so a
// release cut by a single refactor/docs/test/chore commit must not ship a
// header-only GitHub release (v8.38.3, v8.38.1, v8.37.4, …).

const require = createRequire(import.meta.url);
const config = require("../../release.config.cjs") as { plugins: unknown[] };
const notesPlugin = config.plugins.find(
  (p) => Array.isArray(p) && p[0] === "@semantic-release/release-notes-generator",
) as [string, Record<string, unknown>];

const notes = (...messages: string[]): Promise<string> =>
  generateNotes(notesPlugin[1], {
    commits: messages.map((message, i) => ({ message, hash: `${i}`.padStart(40, "a") })),
    lastRelease: { gitTag: "v8.38.2" },
    nextRelease: { version: "8.38.3", gitTag: "v8.38.3" },
    options: { repositoryUrl: "https://github.com/BrainerVirus/workit.git" },
    cwd: process.cwd(),
  });

const body = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "" && !/^#{1,3} /.test(line));

test("a release cut by a single refactor commit gets a non-empty notes body (v8.38.3)", async () => {
  const text = await notes("refactor(core): split the workflow loader (#512)");
  expect(text).toContain("### Code Refactoring");
  expect(body(text)).toEqual([expect.stringContaining("split the workflow loader")]);
});

test.each([
  ["feat: a", "### Features"],
  ["fix: a", "### Bug Fixes"],
  ["perf: a", "### Performance Improvements"],
  ['revert: "feat: a"', "### Reverts"],
  ["docs: a", "### Documentation"],
  ["test: a", "### Tests"],
  ["build: a", "### Build System"],
  ["ci: a", "### Continuous Integration"],
  ["chore: a", "### Miscellaneous Chores"],
])("every release-triggering type has a section: %s", async (message, section) => {
  const text = await notes(message);
  expect(text).toContain(section);
  expect(body(text)).toHaveLength(1);
});

test("manifest-sync and style commits stay out of the notes", async () => {
  const text = await notes(
    "chore(release): sync manifests to v8.38.2 (#500)",
    "style: reformat",
    "fix(cli): keep the exit code (#501)",
  );
  expect(text).not.toContain("sync manifests");
  expect(text).not.toContain("reformat");
  expect(body(text)).toEqual([expect.stringContaining("keep the exit code")]);
});
