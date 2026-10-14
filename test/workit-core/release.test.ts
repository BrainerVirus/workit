import { afterEach, expect, test } from "bun:test";
import { releaseTagPrefixOf } from "@/packages/workit-core/src/core/branch-policy";
import { changelogSection } from "@/packages/workit-core/src/git/release";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// The pieces of `workit release finish` that read the repository: the tag
// prefix (#290 comment) and the changelog section that becomes the tag
// message and the forge release notes.

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const repo = () => {
  const made = makeRemoteRepo();
  repos.push(made);
  return made;
};

test("Given no policy prefix, Then git-flow's versiontag wins (empty included), else v; a policy prefix overrides both", () => {
  const r = repo();
  expect(releaseTagPrefixOf(r.cwd)).toBe("v");
  r.git("config", "gitflow.prefix.versiontag", "");
  expect(releaseTagPrefixOf(r.cwd)).toBe("");
  r.git("config", "gitflow.prefix.versiontag", "rel-");
  expect(releaseTagPrefixOf(r.cwd)).toBe("rel-");
  expect(releaseTagPrefixOf(r.cwd, "x")).toBe("x");
});

test("Given Keep a Changelog and semantic-release headings, Then only the version's section is returned", () => {
  const r = repo();
  r.write(
    "CHANGELOG.md",
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.4.0] - 2026-10-14",
      "### Fixed",
      "- a",
      "",
      "## [1.3.0]",
      "- b",
      "",
      "# [2.0.0](https://example.com/compare) (2026-10-14)",
      "",
      "### Features",
      "* c",
      "",
      "# [1.9.0](x)",
    ].join("\n"),
  );
  r.git("add", "-A");
  r.git("commit", "-qm", "chore: changelog");
  expect(changelogSection(r.cwd, "HEAD", "1.4.0")).toBe("### Fixed\n- a");
  expect(changelogSection(r.cwd, "HEAD", "2.0.0")).toBe("### Features\n* c");
  expect(changelogSection(r.cwd, "HEAD", "1.4")).toBeNull();
  expect(changelogSection(r.cwd, "HEAD", "9.9.9")).toBeNull();
});
