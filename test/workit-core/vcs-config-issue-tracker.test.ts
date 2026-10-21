import { expect, test } from "bun:test";
import { issueTrackerOf } from "@/packages/workit-core/src/core/vcs-config";

// #324: one tracker block per workspace; the old keys are read as aliases.

test("an old config with youtrack.link_issues true reads as issues { provider: youtrack, link: true }", () => {
  expect(
    issueTrackerOf(undefined, { link_issues: true, baseUrl: "https://yt.example.test" }),
  ).toEqual({
    provider: "youtrack",
    link: true,
    relation: "closes",
    backlink: false,
    baseUrl: "https://yt.example.test",
    source: "youtrack.link_issues",
  });
});

test("issues.link_on_pr reads as link, and youtrack.link_issues still wins over a legacy GitHub block", () => {
  expect(issueTrackerOf({ provider: "github", link_on_pr: true }, undefined)).toMatchObject({
    provider: "github",
    link: true,
    source: "issues.link_on_pr",
  });
  expect(
    issueTrackerOf({ provider: "github", link_on_pr: true }, { link_issues: true }),
  ).toMatchObject({ provider: "youtrack", link: true });
});

test("a new issues block is authoritative: provider, link, relation and backlink are read as given", () => {
  expect(
    issueTrackerOf(
      { provider: "gitlab", link: false, relation: "refs", backlink: true },
      { link_issues: true },
    ),
  ).toMatchObject({ provider: "gitlab", link: false, relation: "refs", backlink: true });
});

test("a bare youtrack.baseUrl is a YouTrack tracker that links only named issues; nothing set is no tracker", () => {
  expect(issueTrackerOf(undefined, { baseUrl: "https://yt.example.test" })).toMatchObject({
    provider: "youtrack",
    link: false,
    source: "youtrack.baseUrl",
  });
  expect(issueTrackerOf(undefined, undefined)).toBeNull();
  expect(issueTrackerOf({ provider: "jira" }, undefined)).toBeNull();
});
