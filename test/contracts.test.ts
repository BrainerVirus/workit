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
  expect(text).toContain("correct invalid input before retrying");
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

test("implement confirms every branch setup after previewing branch and stash behavior", () => {
  const text = skill("wf-implement");
  const contract = readFileSync(path.join(import.meta.dir, "..", "templates", "execution-contract.md"), "utf8");
  for (const source of [text, contract]) {
    expect(source).toContain("current branch");
    expect(source).toContain("target branch");
    expect(source).toContain("stash behavior");
    expect(source).toContain("clean tree");
    expect(source).toContain("proceed or cancel");
    expect(source).toContain("workflow_branch_setup");
    expect(source).toContain("confirmed: true");
  }
});

test("issue update names both safe retries and bounds each retry to one attempt", () => {
  const text = skill("wf-issue-update");
  expect(text).toContain('result.data.retry === "workflow_youtrack_post"');
  expect(text).toContain('result.data.retry === "workflow_youtrack_log_time"');
  expect(text).toContain("unchanged reviewed `issueId`, `markdown`, and `minutes`");
  expect(text).toContain("same `issueId` and `minutes`");
  expect(text).toContain("at most once");
  expect(text).toContain("second attempt fails");
});

test("status uses only the aggregate toolkit status tool", () => {
  const text = skill("wf-status");
  expect(text).toContain("Use only `workflow_toolkit_status`");
  expect(text).not.toContain("workflow_youtrack_verify_token");
});

test("native runtime outputs use OpenCode-neutral vocabulary", () => {
  const root = path.resolve(import.meta.dir, "..");
  const sources = [
    "src/legacy/sdd-context.js", "scripts/_shared/common.sh", "scripts/changelog-context.sh",
    "scripts/init/apply.sh", "scripts/vcs/token-create-urls.sh",
  ].map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const stale of ["Cursor TodoWrite", "Cursor AskQuestion", "Cursor plugin", "MCP tool", "Cursor workspace"]) {
    expect(sources).not.toContain(stale);
  }
  expect(sources).toContain("OpenCode");
});
