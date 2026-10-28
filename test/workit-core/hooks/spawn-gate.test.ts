import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #432: a workit:implementer spawn carries a Workit brief and no host isolation.

let configHome: ConfigHome;
let cwd: string;
beforeAll(() => {
  configHome = useConfigHome("wk-spawn-gate-");
  cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-spawn-gate-cwd-")));
});
afterAll(() => {
  configHome.restore();
  rmSync(cwd, { recursive: true, force: true });
});

type Out = {
  hookSpecificOutput?: {
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
const BRIEF =
  "MODE: new\nGOAL: g\nWORKTREE: /w/slice  (made by `workit fanout worktree create slice`; yours alone)\n";
const spawn = (input: Record<string, unknown>): Out =>
  dispatchHook(claudeCodeAdapter, {
    ...fixture("claude-code", "pre-tool-use-bash", cwd),
    tool_name: "Agent",
    tool_input: { description: "d", ...input },
  }).json;

test("G an implementer spawn with a brief and isolation, W PreToolUse runs, T isolation is dropped and the rest kept", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    model: "opus",
    isolation: "worktree",
  });
  expect(out.hookSpecificOutput?.updatedInput).toEqual({
    description: "d",
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  expect(out.hookSpecificOutput?.additionalContext).toContain("removed isolation");
});

test("G an implementer spawn with isolation and no model, W PreToolUse runs, T isolation is dropped and the role model filled", () => {
  const updated = spawn({
    subagent_type: "workit:implementer",
    prompt: BRIEF,
    isolation: "worktree",
  }).hookSpecificOutput?.updatedInput;
  expect(updated?.isolation).toBeUndefined();
  expect(typeof updated?.model).toBe("string");
});

test("G an implementer spawn without a brief, W PreToolUse runs, T it is denied with the worktree command", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt: "fix the tests",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
    "`workit fanout worktree create <slice>`",
  );
  expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("workit fanout brief <slice>");
});

test("G a brief rendered before its worktree was made, W PreToolUse runs, T it is denied too", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt:
      "GOAL: g\nWORKTREE: /w/slice  (not made yet: the lead runs `workit fanout worktree create slice` before spawning)\n",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
});

test("G a WORKTREE line that is only the not-made-yet note, W PreToolUse runs, T it is denied (no regex backtracking)", () => {
  for (const line of [
    "WORKTREE: not made yet",
    "WORKTREE:  not made yet",
    "WORKTREE:not made yet",
  ]) {
    const out = spawn({
      subagent_type: "workit:implementer",
      prompt: `GOAL: g\n${line}\n`,
      model: "opus",
    });
    expect(out.hookSpecificOutput?.permissionDecision, line).toBe("deny");
  }
});

test("G a verifier spawn with isolation and no brief, W PreToolUse runs, T it is left as written", () => {
  const out = spawn({
    subagent_type: "workit:verifier",
    prompt: "verify it",
    model: "sonnet",
    isolation: "worktree",
  });
  expect(out.hookSpecificOutput).toBeUndefined();
});
