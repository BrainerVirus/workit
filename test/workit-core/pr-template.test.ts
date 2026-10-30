import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKIT_PR_TEMPLATE,
  checkPrBody,
  markdownHeadings,
  resolvePrTemplate,
  type PrTemplate,
} from "@/packages/workit-core/src/core/pr-template";

// Which template a PR body fills (`prTemplate`) and what `workit pr create`
// counts as unfilled: a missing template heading, or a template comment left in.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A plain directory (no git: repoRoot falls back to it) holding `files`. */
const repoWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "wk-pr-template-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};

const picked = (cwd: string, setting: string) => {
  const result = resolvePrTemplate(cwd, setting);
  if (!result.ok) throw new Error(`expected a template, got ${result.reason}`);
  return result.template;
};

test("Given a repo with .github/pull_request_template.md, When prTemplate is auto, Then that file is the template", () => {
  const cwd = repoWith({ ".github/pull_request_template.md": "## What\n\n## Why\n" });
  const template = picked(cwd, "auto");
  expect(template).toMatchObject({
    source: "repo",
    path: ".github/pull_request_template.md",
    enforced: true,
  });
  expect(template.headings).toEqual(["What", "Why"]);
});

test("Given no repo template, When prTemplate is auto, Then Workit's template applies; When it is repo, Then it is refused naming the paths searched", () => {
  const cwd = repoWith({});
  expect(picked(cwd, "auto")).toMatchObject({ source: "workit", path: null, enforced: false });
  expect(picked(cwd, "auto").headings).toEqual(["Summary", "Evidence", "Merge danger"]);
  const refused = resolvePrTemplate(cwd, "repo");
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.reason).toBe("pr_template_missing");
  expect(refused.lookedIn).toContain(".github/pull_request_template.md");
  expect(refused.lookedIn).toContain(".gitlab/merge_request_templates/Default.md");
});

test("Given a repo template, When prTemplate is workit, Then Workit's template applies", () => {
  const cwd = repoWith({ ".github/pull_request_template.md": "## What\n" });
  expect(picked(cwd, "workit")).toMatchObject({ content: WORKIT_PR_TEMPLATE, enforced: true });
});

test("Given GitLab Default.md and Feature.md, When prTemplate is auto, Then Default.md applies; When it names Feature.md, Then Feature.md applies", () => {
  const cwd = repoWith({
    ".gitlab/merge_request_templates/Default.md": "## Default\n",
    ".gitlab/merge_request_templates/Feature.md": "## Feature\n",
  });
  expect(picked(cwd, "auto").path).toBe(".gitlab/merge_request_templates/Default.md");
  const feature = picked(cwd, ".gitlab/merge_request_templates/Feature.md");
  expect(feature.path).toBe(".gitlab/merge_request_templates/Feature.md");
  expect(feature.headings).toEqual(["Feature"]);
});

test("Given one file in .github/PULL_REQUEST_TEMPLATE/, When prTemplate is auto, Then it is the template; Given two, Then none is guessed", () => {
  const one = repoWith({ ".github/PULL_REQUEST_TEMPLATE/change.md": "## Change\n" });
  expect(picked(one, "auto").path).toBe(".github/PULL_REQUEST_TEMPLATE/change.md");
  const two = repoWith({
    ".github/PULL_REQUEST_TEMPLATE/a.md": "## A\n",
    ".github/PULL_REQUEST_TEMPLATE/b.md": "## B\n",
  });
  expect(picked(two, "auto").source).toBe("workit");
});

test("Given prTemplate names a file the repo lacks, Then it is refused naming that file", () => {
  const result = resolvePrTemplate(repoWith({}), "docs/pr.md");
  expect(result).toEqual({
    ok: false,
    reason: "pr_template_missing",
    setting: "docs/pr.md",
    lookedIn: ["docs/pr.md"],
  });
});

test("Given headings inside a code fence or an HTML comment, Then they are not template headings", () => {
  expect(
    markdownHeadings("# Title\n<!-- ## Hidden -->\n```md\n## Example\n```\n### Notes ###\n"),
  ).toEqual(["Title", "Notes"]);
});

const TEMPLATE: PrTemplate = {
  setting: "auto",
  source: "repo",
  path: ".github/pull_request_template.md",
  content: "## Summary\n<!-- what changed -->\n\n## Testing\n- [ ] unit\n- [ ] manual\n",
  headings: ["Summary", "Testing"],
  enforced: true,
};

test("Given a template with Summary and Testing, When the body omits Testing, Then Testing is missing", () => {
  expect(checkPrBody("## Summary\nFixes x\n", TEMPLATE)).toEqual({
    missingHeadings: ["Testing"],
    leftComments: [],
  });
});

test("Given a body that keeps the template's comment, Then the comment counts as unfilled", () => {
  expect(
    checkPrBody("## Summary\n<!--  what\nchanged -->\n## Testing\n- [x] unit\n", TEMPLATE),
  ).toEqual({ missingHeadings: [], leftComments: ["<!-- what changed -->"] });
});

test("Given both headings at any level and case, the comment replaced and the checkboxes unticked, Then the body is filled", () => {
  expect(
    checkPrBody(
      "### summary\nFixes x <!-- a note of my own -->\n\n## Testing\n- [ ] unit\n- [ ] manual\n",
      TEMPLATE,
    ),
  ).toEqual({ missingHeadings: [], leftComments: [] });
});

test("Given an empty body, When Workit's template applies, Then all three of its headings are missing", () => {
  const workit = picked(repoWith({}), "workit");
  expect(checkPrBody("", workit).missingHeadings).toEqual(["Summary", "Evidence", "Merge danger"]);
});
