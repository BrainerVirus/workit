import { expect, test } from "bun:test";
import {
  breakingChanges,
  compareUrl,
  compareVersions,
  highlightsOf,
  previousTag,
  renderReleaseNotes,
} from "@/packages/workit-core/src/core/release-notes";

// The forge release body `workit release finish` publishes: Highlights,
// Breaking changes, the version's Keep a Changelog sections, Full changelog.

const SECTION = [
  "### Fixed",
  "",
  "- the widget no longer crashes",
  "",
  "### Removed",
  "",
  "- the legacy `--old` flag",
  "",
  "### Added",
  "",
  "- a dark theme",
  "- BREAKING: config moves to `workit.json`",
  "  (the old file is read once and migrated)",
].join("\n");

test("Given a changelog section with Removed and a BREAKING bullet, When the notes render, Then Breaking changes lists both and Changes keeps the Keep a Changelog order", () => {
  const notes = renderReleaseNotes({
    version: "1.4.0",
    changelog: SECTION,
    compare: "https://github.com/o/r/compare/v1.3.0...v1.4.0",
  });
  expect(notes).toBe(
    [
      "## Breaking changes",
      "",
      "- the legacy `--old` flag",
      "- BREAKING: config moves to `workit.json`",
      "  (the old file is read once and migrated)",
      "",
      "## Changes",
      "",
      "### Added",
      "",
      "- a dark theme",
      "- BREAKING: config moves to `workit.json`",
      "  (the old file is read once and migrated)",
      "",
      "### Removed",
      "",
      "- the legacy `--old` flag",
      "",
      "### Fixed",
      "",
      "- the widget no longer crashes",
      "",
      "**Full changelog**: https://github.com/o/r/compare/v1.3.0...v1.4.0",
      "",
    ].join("\n"),
  );
});

test("Given highlights and no breaking change, When the notes render, Then Highlights lead and Breaking changes is omitted", () => {
  const notes = renderReleaseNotes({
    version: "1.4.0",
    changelog: "### Fixed\n\n- the widget",
    highlights: "- Faster startup",
  });
  expect(notes).toBe(
    "## Highlights\n\n- Faster startup\n\n## Changes\n\n### Fixed\n\n- the widget\n",
  );
  expect(breakingChanges("### Fixed\n\n- the widget")).toEqual([]);
});

test("Given no changelog section and no previous tag, When the notes render, Then they say only the release", () => {
  expect(renderReleaseNotes({ version: "1.4.0", changelog: null })).toBe("Release 1.4.0\n");
});

test("Given a draft, When its Highlights are read, Then the body up to the next ## heading comes back, and none or an empty one reads as null", () => {
  expect(highlightsOf("## Highlights\n\n- one\n- two\n\n## Changes\n\n- x\n")).toBe("- one\n- two");
  expect(highlightsOf("## Changes\n\n- x\n")).toBeNull();
  expect(highlightsOf("## Highlights\n\n## Changes\n")).toBeNull();
});

test("Given GitHub and GitLab, When the compare link is built, Then GitHub uses /compare/a...b and GitLab /-/compare/a...b", () => {
  expect(compareUrl("github", "https://github.com/o/r", "v1.3.0", "v1.4.0")).toBe(
    "https://github.com/o/r/compare/v1.3.0...v1.4.0",
  );
  expect(compareUrl("gitlab", "https://gitlab.com/g/sub/p/", "v1.3.0", "v1.4.0")).toBe(
    "https://gitlab.com/g/sub/p/-/compare/v1.3.0...v1.4.0",
  );
});

test("Given tags of several prefixes and versions, When the previous tag is picked, Then it is the latest earlier one with the same prefix", () => {
  const tags = ["v1.2.0", "v1.10.0", "v1.3.0-rc.1", "v2.0.0", "api/v1.9.0", "vnext", "1.9.9"];
  expect(previousTag(tags, "v", "1.11.0")).toBe("v1.10.0");
  expect(previousTag(tags, "v", "1.3.0")).toBe("v1.3.0-rc.1");
  expect(previousTag(tags, "v", "1.2.0")).toBeNull();
  expect(previousTag(tags, "api/v", "2.0.0")).toBe("api/v1.9.0");
  expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBeLessThan(0);
  expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
});
