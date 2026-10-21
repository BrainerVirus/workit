import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseIssueRef,
  planIssueLinks,
  withIssueLines,
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

const github = { kind: "github" as const, repo: "o/r" };
const gitlab = { kind: "gitlab" as const, repo: "group/project" };

test("parseIssueRef: the id's shape picks the tracker; the PR's own repo is not cross-repo", () => {
  expect(parseIssueRef("#42", github)).toEqual({
    ok: true,
    ref: { tracker: "github", id: "42", repo: null },
  });
  expect(parseIssueRef("42", gitlab)).toEqual({
    ok: true,
    ref: { tracker: "gitlab", id: "42", repo: null },
  });
  expect(parseIssueRef("other/repo#7", github)).toEqual({
    ok: true,
    ref: { tracker: "github", id: "7", repo: "other/repo" },
  });
  expect(parseIssueRef("O/R#7", github)).toMatchObject({ ref: { repo: null } });
  expect(parseIssueRef("IRPT-74", github)).toEqual({
    ok: true,
    ref: { tracker: "youtrack", id: "IRPT-74", repo: null },
  });
  expect(parseIssueRef("https://github.com/o/r/issues/9", github)).toMatchObject({
    ref: { tracker: "github", id: "9", repo: null },
  });
  expect(
    parseIssueRef("https://gitlab.example.test/a/b/c/-/issues/3", {
      kind: "gitlab",
      repo: "group/project",
    }),
  ).toMatchObject({ ref: { tracker: "gitlab", id: "3", repo: "a/b/c" } });
  expect(parseIssueRef("https://yt.example.test/issue/IRPT-75/title", github)).toMatchObject({
    ref: { tracker: "youtrack", id: "IRPT-75" },
  });
});

test("parseIssueRef: a URL on the other forge or an unreadable id is refused", () => {
  expect(parseIssueRef("https://github.com/o/r/issues/9", gitlab)).toMatchObject({ ok: false });
  expect(parseIssueRef("owner/repo42", github)).toMatchObject({ ok: false });
  expect(parseIssueRef("fix the bug", github)).toMatchObject({ ok: false });
});

const tracker = (patch: Partial<IssueTracker>): IssueTracker => ({
  provider: "github",
  link: false,
  relation: "closes",
  backlink: false,
  baseUrl: null,
  source: "issues",
  ...patch,
});

const plan = (
  input: Partial<Parameters<typeof planIssueLinks>[1]>,
  config: IssueTracker | null,
): string[] => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-issue-link-"));
  try {
    const result = planIssueLinks(
      cwd,
      { issues: [], refs: false, branch: null, forge: github, ...input },
      config,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data.links.map((link) => link.line);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

test("planIssueLinks: named issues link in forge syntax, deduplicated; relation refs from config or --refs", () => {
  expect(plan({ issues: ["#42", "42", "other/repo#5"] }, tracker({}))).toEqual([
    "Closes #42",
    "Closes other/repo#5",
  ]);
  expect(plan({ issues: ["42"] }, tracker({ relation: "refs" }))).toEqual(["Refs #42"]);
  expect(plan({ issues: ["42"], refs: true }, null)).toEqual(["Refs #42"]);
  expect(
    plan({ issues: ["IRPT-74"] }, tracker({ provider: "youtrack", baseUrl: "https://yt/" })),
  ).toEqual(["Related to: https://yt/issue/IRPT-74"]);
});

test("planIssueLinks: the branch is read only with link true, and only for the tracker it names", () => {
  expect(plan({ branch: "feature/42-x" }, tracker({}))).toEqual([]);
  expect(plan({ branch: "feature/42-x" }, tracker({ link: true }))).toEqual(["Closes #42"]);
  expect(plan({ branch: "feature/42-x" }, tracker({ link: true, provider: "gitlab" }))).toEqual([]);
  expect(
    plan(
      { branch: "feature/42-x", forge: gitlab },
      tracker({ link: true, provider: "gitlab", relation: "refs" }),
    ),
  ).toEqual(["Refs #42"]);
  // A YouTrack id from the branch needs a base URL, as before.
  expect(
    plan({ branch: "feature/IRPT-740-x" }, tracker({ link: true, provider: "youtrack" })),
  ).toEqual([]);
  expect(
    plan(
      { branch: "feature/IRPT-740-x" },
      tracker({ link: true, provider: "youtrack", baseUrl: "https://yt" }),
    ),
  ).toEqual(["Related to: https://yt/issue/IRPT-740"]);
  // A named issue replaces the branch-derived one.
  expect(plan({ branch: "feature/42-x", issues: ["7"] }, tracker({ link: true }))).toEqual([
    "Closes #7",
  ]);
});

test("withIssueLines appends each line once after a blank line and keeps lines already in the body", () => {
  const links = [{ line: "Closes #42" }, { line: "Related to: https://yt/issue/IRPT-74" }];
  expect(withIssueLines("Why: y", links)).toBe(
    "Why: y\n\nCloses #42\nRelated to: https://yt/issue/IRPT-74",
  );
  expect(withIssueLines("", links.slice(0, 1))).toBe("Closes #42");
  expect(withIssueLines("Why\n\nCloses #42", links.slice(0, 1))).toBe("Why\n\nCloses #42");
});
