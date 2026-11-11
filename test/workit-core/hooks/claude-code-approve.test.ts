// Host-approval spec, Claude Code: PreToolUse asks on a plain
// `workit approve <id>…` with the request rendered from the store and notes
// the ask; PostToolUse of that same call records one grant per id from argv,
// only after a successful run and only in modes where a person answers.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  consumeApproval,
  createApprovalRequest,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-claude-approve-")));
const saved = process.env.WORKIT_STATE_DIR;
let run = 0;
beforeEach(() => {
  run += 1;
  process.env.WORKIT_STATE_DIR = path.join(base, `state-${run}`);
});
afterAll(() => {
  if (saved === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = saved;
  rmSync(base, { recursive: true, force: true });
});

const fields = (repo: string): ApprovalFields => ({
  kind: "first-push",
  action: "workit git push origin main",
  target: { repo, remote: "git@example.com:o/r.git", branch: "main" },
  effect: "creates main on the empty remote",
  subject: { head: "abc123" },
});

const CLI_ENV = { CLAUDE_CODE_ENTRYPOINT: "cli" } as NodeJS.ProcessEnv;

const hook = (
  event: "PreToolUse" | "PostToolUse",
  command: string,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = CLI_ENV,
) =>
  dispatchHook(
    claudeCodeAdapter,
    {
      hook_event_name: event,
      session_id: "lead-session",
      cwd: base,
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "toolu_1",
      ...(event === "PostToolUse"
        ? { tool_response: { stdout: "", stderr: "", interrupted: false } }
        : {}),
      ...extra,
    },
    env,
  ).json.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;

const grantFile = (id: string) =>
  path.join(process.env.WORKIT_STATE_DIR!, "approvals", "grants", `${id}.json`);

/** The ask, then the run: what a person answering yes produces. */
const askAndRun = (
  command: string,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = CLI_ENV,
  post: Record<string, unknown> = {},
) => {
  const pre = hook("PreToolUse", command, extra, env);
  hook("PostToolUse", command, { ...extra, ...post }, env);
  return pre;
};

test.each(["default", "acceptEdits", "plan"])(
  "Given %s mode, When the agent runs exactly workit approve <id> and the call succeeds, Then the hook asks with the stored request and records one grant",
  (mode) => {
    const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
    const pre = askAndRun(`workit approve ${request.id}`, { permission_mode: mode });
    expect(pre?.permissionDecision).toBe("ask");
    expect(pre?.permissionDecisionReason).toContain(request.id);
    expect(pre?.permissionDecisionReason).toContain("workit git push origin main");
    expect(pre?.permissionDecisionReason).toContain(request.hash.slice(0, 12));
    expect(existsSync(grantFile(request.id))).toBe(true);
    expect(consumeApproval(fields("/r/.git"), { session: "x", verb: "git push" }).ok).toBe(true);
  },
);

test("Given two ids in one call, When it succeeds, Then each id read from argv gets its own grant and nothing else does", () => {
  const a = createApprovalRequest(fields("/a/.git"), { session: "s0" });
  const b = createApprovalRequest(fields("/b/.git"), { session: "s0" });
  const other = createApprovalRequest(fields("/c/.git"), { session: "s0" });
  const pre = askAndRun(`workit approve ${a.id} ${b.id}`);
  expect(pre?.permissionDecisionReason).toContain(a.id);
  expect(pre?.permissionDecisionReason).toContain(b.id);
  expect(existsSync(grantFile(a.id))).toBe(true);
  expect(existsSync(grantFile(b.id))).toBe(true);
  expect(existsSync(grantFile(other.id))).toBe(false);
});

test("Given a call that exited non-zero, a PostToolUse with no ask before it, or an ask on another call, Then no grant is recorded", () => {
  const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
  const command = `workit approve ${request.id}`;
  askAndRun(command, {}, CLI_ENV, { tool_response: { stdout: "", exit_code: 1 } });
  expect(existsSync(grantFile(request.id))).toBe(false);
  hook("PostToolUse", command, { tool_use_id: "toolu_never_asked" });
  expect(existsSync(grantFile(request.id))).toBe(false);
  hook("PreToolUse", command, { tool_use_id: "toolu_a" });
  hook("PostToolUse", command, { tool_use_id: "toolu_b" });
  expect(existsSync(grantFile(request.id))).toBe(false);
});

test.each([
  ["auto mode", { permission_mode: "auto" }, CLI_ENV],
  ["bypassPermissions", { permission_mode: "bypassPermissions" }, CLI_ENV],
  ["dontAsk", { permission_mode: "dontAsk" }, CLI_ENV],
  ["an SDK prompt tool", {}, { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }],
  ["claude -p", {}, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
])("Given %s, When the call runs, Then nothing is recorded", (_name, extra, env) => {
  const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
  askAndRun(`workit approve ${request.id}`, extra, env);
  expect(existsSync(grantFile(request.id))).toBe(false);
});

test.each([
  "cd /tmp && workit approve ID",
  "FOO=1 workit approve ID",
  "workit approve $(echo ID)",
  "echo y | workit approve ID",
  "workit approve ID; echo done",
  "workit approve ID > /tmp/out",
  "workit --cwd /tmp approve ID",
])(
  "Given %s, When Claude Code's PreToolUse runs, Then it is denied naming the plain form and nothing is recorded",
  (shape) => {
    const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
    const command = shape.replaceAll("ID", request.id);
    const pre = askAndRun(command);
    expect(pre?.permissionDecision).toBe("deny");
    expect(pre?.permissionDecisionReason).toContain(
      shape.includes("$(") ? "workit approve <id>" : `\`workit approve ${request.id}\``,
    );
    expect(existsSync(grantFile(request.id))).toBe(false);
  },
);

test("Given a command that only mentions workit approve, When Claude Code's PreToolUse runs, Then the approve channel does not act on it", () => {
  const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
  for (const command of [
    `workit ledger decision "ran workit approve ${request.id}" --why x`,
    "workit help approve",
  ]) {
    const pre = hook("PreToolUse", command);
    expect(pre?.permissionDecision, command).not.toBe("deny");
    expect(pre?.permissionDecision, command).not.toBe("ask");
  }
});

test("Given workit approve with no live request id, When Claude Code's PreToolUse runs, Then there is no ask and nothing is recorded; one live id among them keeps the ask", () => {
  const pre = askAndRun("workit approve ap_zzzzzzzz ap_yyyyyyyy");
  expect(pre?.permissionDecision).not.toBe("ask");
  expect(existsSync(grantFile("ap_zzzzzzzz"))).toBe(false);
  const request = createApprovalRequest(fields("/r/.git"), { session: "s0" });
  const mixed = hook("PreToolUse", `workit approve ap_zzzzzzzz ${request.id}`);
  expect(mixed?.permissionDecision).toBe("ask");
  expect(mixed?.permissionDecisionReason).toContain("workit git push origin main");
});
