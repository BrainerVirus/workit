// #864, Claude Code: PreToolUse asks on a plain `workit youtrack …` write
// with its full text and runs that call with a ticket; a wrapped call is
// denied with the plain form; auto mode is a mode where a person answers, for
// the inline ask and for `workit approve <id>` alike. Payloads are shaped
// like Claude Code 2.1.323's (permission_mode "auto" in every session of the
// #864 retro).
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  consumeApproval,
  createApprovalRequest,
  type ApprovalFields,
} from "@/packages/workit-core/src/approvals/store";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-claude-inline-")));
const saved = { state: process.env.WORKIT_STATE_DIR, config: process.env.WORKIT_CONFIG };
let run = 0;
beforeAll(() => {
  mkdirSync(path.join(base, "config"), { recursive: true });
  process.env.WORKIT_CONFIG = path.join(base, "config");
});
beforeEach(() => {
  run += 1;
  process.env.WORKIT_STATE_DIR = path.join(base, `state-${run}`);
});
afterAll(() => {
  for (const [key, value] of [
    ["WORKIT_STATE_DIR", saved.state],
    ["WORKIT_CONFIG", saved.config],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(base, { recursive: true, force: true });
});

const CLI_ENV = { CLAUDE_CODE_ENTRYPOINT: "cli" } as NodeJS.ProcessEnv;
type Out = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: { command: string };
};

const hook = (
  event: "PreToolUse" | "PostToolUse",
  command: string,
  mode = "auto",
  env: NodeJS.ProcessEnv = CLI_ENV,
) =>
  (dispatchHook(
    claudeCodeAdapter,
    {
      session_id: "0b7c2e4a-9f1d-4c58-8a36-2d0f5e7b9c11",
      transcript_path: path.join(base, "transcript.jsonl"),
      cwd: base,
      permission_mode: mode,
      hook_event_name: event,
      tool_name: "Bash",
      tool_input: { command, description: "Post the note" },
      tool_use_id: "toolu_01TZEuhk7QhUHNQm8USkuWy6",
      ...(event === "PostToolUse"
        ? { tool_response: { stdout: "", stderr: "", interrupted: false } }
        : {}),
    },
    env,
  ).json.hookSpecificOutput ?? {}) as Out;

const inlineRows = () => {
  const dir = path.join(process.env.WORKIT_STATE_DIR!, "approvals", "inline");
  return existsSync(dir) ? readdirSync(dir) : [];
};

test("Given auto mode, When the agent runs workit youtrack time X-1 --minutes 30, Then the hook asks with the entry and runs that call with a ticket", () => {
  const out = hook("PreToolUse", "workit youtrack time X-1 --minutes 30 --text 'code review'");
  expect(out.permissionDecision).toBe("ask");
  expect(out.permissionDecisionReason).toContain(
    'time on X-1: 30 minutes on today ("code review")',
  );
  expect(out.updatedInput?.command).toMatch(
    /^WORKIT_APPROVAL_TICKET=[A-Za-z0-9_-]{32} workit youtrack time X-1 --minutes 30 --text 'code review'$/u,
  );
  expect(inlineRows()).toHaveLength(1);
});

test("Given a comment longer than the prompt shows, When the hook asks, Then the text is cut with how many lines are left", () => {
  const lines = Array.from({ length: 75 }, (_, index) => `line ${index + 1}`);
  writeFileSync(path.join(base, "long.md"), lines.join("\n"));
  const out = hook("PreToolUse", "workit youtrack update X-1 --file long.md --minutes 15");
  expect(out.permissionDecisionReason).toContain("line 60");
  expect(out.permissionDecisionReason).not.toContain("line 61");
  expect(out.permissionDecisionReason).toContain("… 15 more lines");
  expect(out.permissionDecisionReason).toContain("time on X-1: 15 minutes");
});

test("Given a YouTrack write inside a pipe, a chain or bash -c, When the hook runs, Then it denies naming the plain call and records nothing", () => {
  for (const command of [
    "workit youtrack note X-1 --markdown hi 2>&1 | tail -5",
    "cd /tmp && workit youtrack note X-1 --markdown hi",
    "bash -c 'workit youtrack note X-1 --markdown hi'",
  ]) {
    const out = hook("PreToolUse", command);
    expect(out.permissionDecision, command).toBe("deny");
    expect(out.permissionDecisionReason, command).toContain(
      "Run `workit youtrack note X-1 --markdown hi` as its own call",
    );
  }
  expect(inlineRows()).toEqual([]);
});

test("Given a call the verb refuses before writing (no text, a missing file), When the hook runs, Then nothing asks", () => {
  for (const command of [
    "workit youtrack note X-1",
    "workit youtrack note X-1 --file missing.md",
    "workit youtrack show X-1",
  ])
    expect(hook("PreToolUse", command).permissionDecision, command).toBeUndefined();
  expect(inlineRows()).toEqual([]);
});

test("Given auto mode, When the user says yes to workit approve <id>, Then the grant is recorded (the retro's lost yes)", () => {
  const fields: ApprovalFields = {
    kind: "first-push",
    action: "workit git push origin main",
    target: { repo: base, branch: "main" },
    effect: "creates main on the empty remote",
    subject: { head: "abc123" },
  };
  const request = createApprovalRequest(fields, { session: "s" });
  expect(hook("PreToolUse", `workit approve ${request.id}`).permissionDecision).toBe("ask");
  hook("PostToolUse", `workit approve ${request.id}`);
  expect(consumeApproval(fields, { session: "s", verb: "git push" }).ok).toBe(true);
});

test("Given bypassPermissions, When the user-only workit approve runs, Then no grant is recorded", () => {
  const fields: ApprovalFields = {
    kind: "first-push",
    action: "workit git push origin main",
    target: { repo: base, branch: "main" },
    effect: "creates main on the empty remote",
    subject: { head: "def456" },
  };
  const request = createApprovalRequest(fields, { session: "s" });
  hook("PreToolUse", `workit approve ${request.id}`, "bypassPermissions");
  hook("PostToolUse", `workit approve ${request.id}`, "bypassPermissions");
  expect(consumeApproval(fields, { session: "s", verb: "git push" }).ok).toBe(false);
});
