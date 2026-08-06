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

test("handoff always ends the originating turn and never falls back inline", () => {
  const text = skill("wf-handoff");
  expect(text).toContain("After any `workflow_handoff_session` result—success, partial, or failure—end the originating turn immediately");
  expect(text).toContain("Never create todos, execute the plan inline, modify files, retry handoff, or call another tool");
});

test("wf commands never emit a bare Arguments: label", () => {
  const dir = path.join(import.meta.dir, "..", "commands");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    expect(text).not.toMatch(/Arguments:\s*\$ARGUMENTS/);
    expect(text).not.toMatch(/Arguments:\s*$/m);
  }
});

test("post-plan override lists five fixed options and forbids two-option prose", () => {
  const root = path.resolve(import.meta.dir, "..");
  const surfaces = [
    readFileSync(path.join(root, "templates", "superpowers-doc-contract.md"), "utf8"),
    readFileSync(path.join(root, "src", "bootstrap.ts"), "utf8"),
    readFileSync(path.join(root, "cursor", "rules", "ask-question-only.mdc"), "utf8"),
  ].join("\n");
  for (const label of [
    "Subagent-driven",
    "Inline",
    "Handoff",
    "Review spec first",
    "Review plan first",
  ]) {
    expect(surfaces).toContain(label);
  }
  const stripped = surfaces.replace(/do not emit[^\n]+/gi, "");
  expect(stripped).not.toMatch(/Two execution options:\s*\n/);
  expect(stripped).not.toContain("1. Subagent-Driven (recommended)");
  expect(surfaces).toMatch(/no stay|No `--stay` option/i);
  expect(surfaces).toContain("workflow_docs_validate");
});

test("implement review policy caps blockers and defers advisories", () => {
  const text = skill("wf-implement");
  const contract = readFileSync(path.join(import.meta.dir, "..", "templates", "execution-contract.md"), "utf8");
  for (const source of [text, contract]) {
    expect(source).toMatch(/two|2/);
    expect(source).toMatch(/advisory|Advisory/i);
    expect(source).toMatch(/Critical|Important|spec-compliance/);
  }
});

test("PR skills show title and body before create confirmation", () => {
  const root = path.resolve(import.meta.dir, "..");
  for (const rel of [
    "skills/wf-pr/SKILL.md",
    "cursor/skills/wf-pr/SKILL.md",
  ]) {
    const text = readFileSync(path.join(root, rel), "utf8");
    const body = text.split("## Rules")[0] ?? text;
    const showIdx = body.search(/\*\*Show\*\*|Show title|Show the exact Title|Title:\s*\n|<copy-paste title>/i);
    const createQ = body.search(/Create the reviewed|create this MR\/PR|Create MR\/PR now|before creation/i);
    const createTool = body.indexOf("workflow_pr_create");
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(createQ).toBeGreaterThan(showIdx);
    expect(createTool).toBeGreaterThan(createQ);
  }
});

test("native runtime outputs use OpenCode-neutral vocabulary", () => {
  const root = path.resolve(import.meta.dir, "..");
  const sources = [
    "src/core/sdd.ts", "scripts/_shared/common.sh", "scripts/changelog-context.sh",
    "scripts/init/apply.sh", "scripts/vcs/token-create-urls.sh",
  ].map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const stale of ["Cursor TodoWrite", "Cursor AskQuestion", "Cursor plugin", "MCP tool", "Cursor workspace"]) {
    expect(sources).not.toContain(stale);
  }
  expect(sources).toContain("OpenCode");
});

test("quality templates and findings are wired into contracts", () => {
  const implement = readFileSync(path.resolve(import.meta.dir, "../skills/wf-implement/SKILL.md"), "utf8");
  const exec = readFileSync(path.resolve(import.meta.dir, "../templates/execution-contract.md"), "utf8");
  const specContract = readFileSync(path.resolve(import.meta.dir, "../templates/superpowers-doc-contract.md"), "utf8");
  expect(implement).toMatch(/spec-template\.md|plan-template\.md/);
  expect(implement).toMatch(/quality/);
  expect(exec).toMatch(/quality/);
  expect(specContract).toMatch(/spec-template\.md/);
});
