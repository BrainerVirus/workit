import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const skill = (name: string) => readFileSync(path.join(import.meta.dir, "..", "skills", name, "SKILL.md"), "utf8");

test("all native skills exist and contain no Cursor runtime vocabulary", () => {
  const root = path.resolve(import.meta.dir, "..");
  const dirs = readdirSync(path.join(root, "skills")).filter((name) => name.startsWith("wf-"));
  expect(dirs).toHaveLength(12);
  const source = dirs.map((dir) => readFileSync(path.join(root, "skills", dir, "SKILL.md"), "utf8")).join("\n");
  for (const forbidden of ["Cursor TodoWrite", "Cursor AskQuestion", "${workspaceFolder}", "~/.cursor/plugins", "copy-paste prompt", "MCP tool", "/handoff-next-session", "/implement-from-plan"]) {
    expect(source).not.toContain(forbidden);
  }
  for (const required of ["question", "todowrite", "task", "workflow_handoff_session", "workflow_verify"]) {
    expect(source).toContain(required);
  }
});

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
