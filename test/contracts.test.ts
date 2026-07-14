import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const skill = (name: string) => readFileSync(path.join(import.meta.dir, "..", "skills", name, "SKILL.md"), "utf8");

test("meetings logs the sole configured target with explicit confirmation", () => {
  const text = skill("wf-meetings");
  expect(text).not.toContain("Pick meeting type");
  expect(text).toContain("`confirmed: true`, `issueId`, `minutes`, `text`");
});

test("issue update consumes the Result envelope and retries only proven missing time", () => {
  const text = skill("wf-issue-update");
  expect(text).toContain("result.ok");
  expect(text).toContain("result.data.postedComment");
  expect(text).toContain("result.data.retry");
  expect(text).toContain("`confirmed: true`, `issueId`, `minutes`");
  expect(text).toContain("outcome is `unknown`");
  expect(text).not.toContain("partial: true");
});
