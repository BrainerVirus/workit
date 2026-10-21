import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseIssueRef,
  planIssueLinks,
  withIssueLines,
  type IssueLink,
  type PrForge,
} from "@/packages/workit-core/src/forge/issue-link";
import type { IssueTracker } from "@/packages/workit-core/src/core/vcs-config";

// Never the machine's own youtrack.json: a base URL comes from the tracker only.
const previousYouTrack = process.env.WORKFLOW_YOUTRACK_CONFIG;
beforeAll(() => {
  process.env.WORKFLOW_YOUTRACK_CONFIG = path.join(os.tmpdir(), "wk-no-youtrack", "youtrack.json");
});
afterAll(() => {
  if (previousYouTrack === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
  else process.env.WORKFLOW_YOUTRACK_CONFIG = previousYouTrack;
});

const github: PrForge = { kind: "github", repo: "o/r", host: "github.com" };
const gitlab: PrForge = { kind: "gitlab", repo: "group/project", host: "gitlab.com" };

test("parseIssueRef: YouTrack ids and URLs name their tracker; a short form is on the given tracker", () => {
  expect(parseIssueRef("#42", "github")).toEqual({
    ok: true,
    ref: { tracker: "github", id: "42", repo: null, host: null },
  });
  expect(parseIssueRef("42", "gitlab")).toMatchObject({ ref: { tracker: "gitlab", id: "42" } });
  expect(parseIssueRef("other/repo#7", "github")).toMatchObject({
    ref: { tracker: "github", id: "7", repo: "other/repo", host: null },
  });
  expect(parseIssueRef("IRPT-74", "gitlab")).toMatchObject({
    ref: { tracker: "youtrack", id: "IRPT-74" },
  });
  expect(parseIssueRef("https://github.com/o/r/issues/9", "gitlab")).toMatchObject({
    ref: { tracker: "github", id: "9", repo: "o/r", host: "github.com" },
  });
  expect(parseIssueRef("https://gitlab.example.test/a/b/c/-/issues/3", "github")).toMatchObject({
    ref: { tracker: "gitlab", id: "3", repo: "a/b/c", host: "gitlab.example.test" },
  });
  expect(parseIssueRef("https://yt.example.test/issue/IRPT-75/title", "github")).toMatchObject({
    ref: { tracker: "youtrack", id: "IRPT-75" },
  });
  expect(parseIssueRef("owner/repo42", "github")).toMatchObject({ ok: false });
  expect(parseIssueRef("fix the bug", "github")).toMatchObject({ ok: false });
});

const tracker = (patch: Partial<IssueTracker>): IssueTracker => ({
  provider: "github",
  link: false,
  relation: "closes",
  backlink: false,
  baseUrl: null,
  repo: null,
  host: null,
  source: "issues",
  warnings: [],
  ...patch,
});

const planned = (
  input: Partial<Parameters<typeof planIssueLinks>[1]>,
  config: IssueTracker | null,
) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issue-link-"));
  try {
    return planIssueLinks(
      cwd,
      { issues: [], refs: false, branch: null, forge: github, ...input },
      config,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

const links = (
  input: Partial<Parameters<typeof planIssueLinks>[1]>,
  config: IssueTracker | null,
): IssueLink[] => {
  const result = planned(input, config);
  if (!result.ok) throw new Error(result.error);
  return result.data.links;
};

const lines = (
  input: Partial<Parameters<typeof planIssueLinks>[1]>,
  config: IssueTracker | null,
): string[] => links(input, config).map((link) => link.line);

test("planIssueLinks: same-forge issues close in forge syntax, deduplicated; relation refs from config or --refs", () => {
  expect(lines({ issues: ["#42", "42", "other/repo#5", "o/r#42"] }, tracker({}))).toEqual([
    "Closes #42",
    "Closes other/repo#5",
  ]);
  expect(lines({ issues: ["42"] }, tracker({ relation: "refs" }))).toEqual(["Refs #42"]);
  expect(lines({ issues: ["42"], refs: true }, null)).toEqual(["Refs #42"]);
  // Issues kept in another repository of the same forge close there.
  expect(lines({ issues: ["9"] }, tracker({ repo: "o/issues" }))).toEqual(["Closes o/issues#9"]);
});

test("planIssueLinks: YouTrack issues are Related to lines with relation related", () => {
  expect(
    links({ issues: ["IRPT-74"] }, tracker({ provider: "youtrack", baseUrl: "https://yt/" })),
  ).toEqual([
    expect.objectContaining({
      tracker: "youtrack",
      relation: "related",
      line: "Related to: https://yt/issue/IRPT-74",
    }),
  ]);
});

test("planIssueLinks: given a GitHub forge and GitLab issues, then a bare number is the GitLab issue, linked by URL, never Closes #n", () => {
  const config = tracker({ provider: "gitlab", repo: "group/project" });
  expect(links({ issues: ["7"] }, config)).toEqual([
    expect.objectContaining({
      tracker: "gitlab",
      id: "7",
      repo: "group/project",
      host: "gitlab.com",
      relation: "related",
      line: "Related to: https://gitlab.com/group/project/-/issues/7",
    }),
  ]);
  // A GitLab issue URL is accepted on a GitHub PR.
  expect(
    lines(
      { issues: ["https://gitlab.example.test/g/p/-/issues/3"] },
      tracker({ provider: "gitlab" }),
    ),
  ).toEqual(["Related to: https://gitlab.example.test/g/p/-/issues/3"]);
  // The branch still derives the issue, on the configured tracker.
  expect(lines({ branch: "feature/42-x" }, { ...config, link: true })).toEqual([
    "Related to: https://gitlab.com/group/project/-/issues/42",
  ]);
  // Without issues.repo a bare number cannot be placed: refused, not mislinked.
  expect(planned({ issues: ["7"] }, tracker({ provider: "gitlab" }))).toMatchObject({
    ok: false,
    error: expect.stringContaining("set issues.repo"),
  });
  const skipped = planned({ branch: "feature/42-x" }, tracker({ provider: "gitlab", link: true }));
  expect(skipped).toMatchObject({ ok: true, data: { links: [] } });
  expect(skipped.ok && skipped.data.warnings[0]).toContain("the branch issue is not linked");
});

test("planIssueLinks: given a GitLab forge and GitHub issues, then the GitHub issue is linked by URL", () => {
  const config = tracker({ provider: "github", repo: "o/r", link: true });
  expect(lines({ issues: ["#5"], forge: gitlab }, config)).toEqual([
    "Related to: https://github.com/o/r/issues/5",
  ]);
  expect(lines({ branch: "feature/12-x", forge: gitlab }, config)).toEqual([
    "Related to: https://github.com/o/r/issues/12",
  ]);
  // GitLab's own issues on a GitLab forge still close.
  expect(lines({ issues: ["7"], forge: gitlab }, tracker({ provider: "gitlab" }))).toEqual([
    "Closes #7",
  ]);
});

test("planIssueLinks: the branch is read only with link true; a YouTrack id from it needs a base URL", () => {
  expect(lines({ branch: "feature/42-x" }, tracker({}))).toEqual([]);
  expect(lines({ branch: "feature/42-x" }, tracker({ link: true }))).toEqual(["Closes #42"]);
  expect(
    lines({ branch: "feature/IRPT-740-x" }, tracker({ link: true, provider: "youtrack" })),
  ).toEqual([]);
  expect(
    lines(
      { branch: "feature/IRPT-740-x" },
      tracker({ link: true, provider: "youtrack", baseUrl: "https://yt" }),
    ),
  ).toEqual(["Related to: https://yt/issue/IRPT-740"]);
  // A named issue replaces the branch-derived one.
  expect(lines({ branch: "feature/42-x", issues: ["7"] }, tracker({ link: true }))).toEqual([
    "Closes #7",
  ]);
});

test("withIssueLines appends each line once after a blank line and keeps lines already in the body", () => {
  const two = [{ line: "Closes #42" }, { line: "Related to: https://yt/issue/IRPT-74" }];
  expect(withIssueLines("Why: y", two)).toBe(
    "Why: y\n\nCloses #42\nRelated to: https://yt/issue/IRPT-74",
  );
  expect(withIssueLines("", two.slice(0, 1))).toBe("Closes #42");
  expect(withIssueLines("Why\n\nCloses #42", two.slice(0, 1))).toBe("Why\n\nCloses #42");
});
