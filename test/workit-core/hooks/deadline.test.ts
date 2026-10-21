// The hook's own deadline (issue #309): past it the host gets a minimal valid
// result naming the skip instead of a killed hook, and each skip is recorded.
// Slow steps are faked (a handler that never settles, a clock already past the
// deadline), never slept.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
  runHookProcess,
  type HostAdapter,
} from "@/packages/workit-core/src/hooks/index";
import {
  countHookSkips,
  recordHookSkip,
  type HookDeadline,
  type HookSkip,
} from "@/packages/workit-core/src/hooks/deadline";
import { fixture, tempRoot } from "./hook-fixtures";

const roots: string[] = [];
const root = () => {
  const dir = tempRoot("workit-deadline-");
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SKIP = "workit context skipped: host under load";
const NEVER = () => new Promise<never>(() => {});

type Run = { json: Record<string, unknown>; exitCode: number; stderr: string; skips: HookSkip[] };

const run = async (
  adapter: HostAdapter,
  payload: unknown,
  deadline: Omit<HookDeadline, "record">,
  stdin?: AsyncIterable<unknown>,
): Promise<Run> => {
  let stdout = "";
  let stderr = "";
  const skips: HookSkip[] = [];
  const exitCode = await runHookProcess(
    adapter,
    stdin ?? [JSON.stringify(payload)],
    { write: (chunk: string) => (stdout += chunk) },
    { write: (chunk: string) => (stderr += chunk) },
    process.env,
    { ...deadline, record: (skip) => skips.push(skip) },
  );
  return { json: JSON.parse(stdout), exitCode, stderr, skips };
};

const slow = { deadlineMs: 20, startedAt: Date.now(), dispatch: NEVER };

test("Given a Claude Code UserPromptSubmit whose handler overruns the deadline, When it returns, Then Claude gets additionalContext naming the skip and the skip is recorded", async () => {
  const cwd = root();
  const out = await run(claudeCodeAdapter, fixture("claude-code", "user-prompt-submit", cwd), {
    ...slow,
    startedAt: Date.now(),
  });
  expect(out.exitCode).toBe(0);
  expect(out.json).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: SKIP },
  });
  expect(out.stderr).toContain("past the 20 ms hook deadline");
  expect(out.skips).toEqual([
    expect.objectContaining({
      host: "claude_code",
      event: "context.turn",
      outcome: "skip",
      stage: "dispatch",
    }),
  ]);
});

test("Given a Claude Code Stop past the deadline, When it returns, Then the answer is the empty no-decision result (no continuation)", async () => {
  const out = await run(claudeCodeAdapter, fixture("claude-code", "stop", root()), {
    ...slow,
    startedAt: Date.now(),
  });
  expect(out.json).toEqual({});
  expect(out.skips[0]).toMatchObject({ event: "stop", outcome: "skip" });
});

test("Given a Codex PreToolUse past the deadline, When it returns, Then Codex gets its PreToolUse output naming the skip", async () => {
  const out = await run(codexAdapter, fixture("codex", "pre-tool-use-bash", root()), {
    ...slow,
    startedAt: Date.now(),
  });
  expect(out.exitCode).toBe(0);
  expect(out.json).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: SKIP },
  });
  expect(out.skips[0]).toMatchObject({ host: "codex_cli", event: "shell.pre" });
});

test("Given a Cursor beforeShellExecution past the deadline, When it returns, Then Cursor gets its required permission answer with the skip as agent_message", async () => {
  const out = await run(cursorAdapter, fixture("cursor", "before-shell-execution", root()), {
    ...slow,
    startedAt: Date.now(),
  });
  expect(out.exitCode).toBe(0);
  expect(out.json).toEqual({ permission: "allow", agent_message: SKIP });
  expect(out.skips[0]).toMatchObject({ host: "cursor", event: "shell.pre" });
});

test("Given a hook whose start-up already spent the budget, When it runs, Then the handler is never called", async () => {
  let called = false;
  const out = await run(
    claudeCodeAdapter,
    fixture("claude-code", "session-start-compact", root()),
    {
      deadlineMs: 8_000,
      startedAt: 0,
      now: () => 8_000,
      dispatch: () => {
        called = true;
        throw new Error("must not run");
      },
    },
  );
  expect(called).toBe(false);
  expect(out.json).toEqual({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SKIP },
  });
});

test("Given a payload that never finishes arriving, When the deadline passes, Then the host still gets a valid empty answer", async () => {
  const stalled: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({ next: NEVER }),
  };
  const out = await run(
    claudeCodeAdapter,
    null,
    { deadlineMs: 20, startedAt: Date.now() },
    stalled,
  );
  expect(out.json).toEqual({});
  expect(out.skips).toEqual([expect.objectContaining({ event: null, stage: "input" })]);
});

test("Given a normal fast hook, When it runs under the deadline, Then its output is the plain dispatch output and nothing is recorded", async () => {
  const cwd = root();
  const payload = fixture("codex", "pre-tool-use-bash", cwd, {
    tool_input: { command: "git checkout -b main" },
  });
  const out = await run(codexAdapter, payload, {});
  expect(out.json).toEqual(dispatchHook(codexAdapter, payload, process.env).json);
  expect(out.json).not.toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: SKIP },
  });
  expect(out.skips).toEqual([]);
});

test("Given a handler that finishes after the deadline, When it returns, Then its full answer is kept and recorded as late", async () => {
  let clock = 0;
  const out = await run(claudeCodeAdapter, fixture("claude-code", "stop", root()), {
    deadlineMs: 100,
    startedAt: 0,
    now: () => clock,
    dispatch: () => {
      clock = 150;
      return { json: { decision: "block", reason: "finish" }, exitCode: 0, error: null };
    },
  });
  expect(out.json).toEqual({ decision: "block", reason: "finish" });
  expect(out.skips).toEqual([
    expect.objectContaining({ outcome: "late", stage: "done", elapsedMs: 150 }),
  ]);
});

test("Given recorded skips, When they are counted for the last day, Then older rows and torn lines are left out", () => {
  const state = mkdtempSync(path.join(tmpdir(), "workit-deadline-state-"));
  roots.push(state);
  const row = (at: string, outcome: HookSkip["outcome"]): HookSkip => ({
    at,
    host: "claude_code",
    event: "context.turn",
    outcome,
    stage: "dispatch",
    elapsedMs: 9000,
  });
  recordHookSkip(row("2026-10-20T10:00:00Z", "skip"), state);
  recordHookSkip(row("2026-10-21T09:00:00Z", "skip"), state);
  recordHookSkip(row("2026-10-21T09:30:00Z", "late"), state);
  appendFileSync(path.join(state, "hook-skips.jsonl"), '{"at":"2026-10-21T09:40:00Z","outc\n');
  expect(countHookSkips(state, Date.parse("2026-10-20T12:00:00Z"))).toEqual({ skip: 1, late: 1 });
});

test("Given no state dir, When skips are counted, Then the count is zero", () => {
  expect(countHookSkips(path.join(tmpdir(), "workit-no-such-state-dir"), 0)).toEqual({
    skip: 0,
    late: 0,
  });
});
