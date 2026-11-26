// #994 through the real Codex hook process (hooks/launcher.ts under bun): every
// plain `workit` call reaches the runtime, which files its stamp under the
// calling thread (a subagent's agent_id, else the lead's session_id); a command
// that changes an identity variable reaches the identity guard; PostToolUse
// drops a finished call's unclaimed stamps without loading the runtime.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-codex-stamp-launcher-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const state = path.join(base, "state");
const root = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", root]);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  WORKIT_STATE_DIR: state,
};
for (const key of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "WORKIT_CONFIG", "WORKIT_CONFIG_DIR"])
  delete env[key];

type Output = {
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
};

const hook = (payload: Record<string, unknown>): Output => {
  const child = spawnSync(process.execPath, [LAUNCHER], {
    input: JSON.stringify({
      cwd: root,
      model: "gpt-5",
      permission_mode: "default",
      transcript_path: null,
      turn_id: "turn-1",
      tool_name: "bash",
      ...payload,
    }),
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Output;
};
/** A shell call's PreToolUse: the lead's (no agent) or a subagent's (its thread as agent_id). */
const pre = (
  command: unknown,
  who: { lead: string; thread?: string },
  toolUseId = `call-${crypto.randomUUID()}`,
  tool = "bash",
) =>
  hook({
    hook_event_name: "PreToolUse",
    session_id: who.lead,
    ...(who.thread ? { agent_id: who.thread, agent_type: "default" } : {}),
    tool_name: tool,
    tool_use_id: toolUseId,
    tool_input: { command },
  });
const post = (command: string, who: { lead: string; thread?: string }, toolUseId: string) =>
  hook({
    hook_event_name: "PostToolUse",
    session_id: who.lead,
    ...(who.thread ? { agent_id: who.thread, agent_type: "default" } : {}),
    tool_use_id: toolUseId,
    tool_input: { command },
    tool_response: "",
  });
/** The stamps filed under one thread (agent-stamp.ts stampDir). */
const stamps = (thread: string): string[] => {
  const dir = path.join(
    state,
    "agent-stamps",
    createHash("sha256").update(thread).digest("hex").slice(0, 32),
  );
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const thread = () => `019a${crypto.randomUUID().slice(4)}`;

test("Given a Codex lead's plain `workit check lint`, When its PreToolUse runs, Then the runtime files a stamp under the lead's thread with no agent id", () => {
  const lead = thread();
  expect(pre("workit check lint", { lead }).hookSpecificOutput?.permissionDecision).toBeUndefined();
  const filed = stamps(lead);
  expect(filed).toHaveLength(1);
  expect(filed[0]?.split(".")[1]).toBe("");
}, 60_000);

test("Given a Codex subagent's `workit check lint`, Then its stamp is filed under its own thread and none under the lead's", () => {
  const lead = thread();
  const sub = thread();
  pre("workit check lint", { lead, thread: sub });
  expect(stamps(sub)).toHaveLength(1);
  expect(stamps(sub)[0]?.split(".")[1]).toBe("");
  expect(stamps(lead)).toEqual([]);
}, 60_000);

test("Given the unified-exec argv shape, Then a subagent's `workit` call is stamped under its own thread", () => {
  const lead = thread();
  const sub = thread();
  pre(["bash", "-lc", "workit check lint"], { lead, thread: sub }, "call-ue", "unified-exec");
  expect(stamps(sub)).toHaveLength(1);
  expect(stamps(lead)).toEqual([]);
}, 60_000);

test("Given a command with no workit call, Then it stays quiet and stamps nothing", () => {
  const lead = thread();
  expect(pre("ls", { lead })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
  expect(stamps(lead)).toEqual([]);
}, 60_000);

// A host variable counts beside a workit run (#981); a Workit identity variable counts alone.
test("Given a command that sets CODEX_THREAD_ID for a workit run or exports WORKIT_SESSION_ID, When the Codex hook runs, Then the identity guard denies it", () => {
  for (const command of [
    "CODEX_THREAD_ID=x workit check lint",
    "export CODEX_THREAD_ID=x; workit check lint",
    "export WORKIT_SESSION_ID=x",
    "unset WORKIT_AGENT_ID",
  ])
    expect(
      pre(command, { lead: thread(), thread: thread() }).hookSpecificOutput?.permissionDecision,
      command,
    ).toBe("deny");
}, 60_000);

test("Given a finished call whose `workit` never ran, When its PostToolUse runs, Then the call's stamp goes; a backgrounded call's stays", () => {
  const lead = thread();
  const sub = thread();
  const who = { lead, thread: sub };
  pre("false && workit check lint", who, "call-done");
  pre("workit check test > out.txt 2>&1 &", who, "call-bg");
  expect(stamps(sub)).toHaveLength(2);
  expect(post("false && workit check lint", who, "call-done").hookSpecificOutput).toEqual({
    hookEventName: "PostToolUse",
  });
  post("workit check test > out.txt 2>&1 &", who, "call-bg");
  expect(stamps(sub)).toHaveLength(1);
}, 60_000);
