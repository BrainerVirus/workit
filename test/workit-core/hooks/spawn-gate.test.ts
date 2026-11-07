import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

// #432: a workit:implementer spawn carries a Workit brief; #654: no spawn
// type keeps host isolation.

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

const denied = (out: Out): string => {
  expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  return out.hookSpecificOutput?.permissionDecisionReason ?? "";
};

test("G an implementer spawn with a brief and isolation, W PreToolUse runs, T it is denied with the same args without isolation, and that retry runs as written", () => {
  const reason = denied(
    spawn({
      subagent_type: "workit:implementer",
      prompt: BRIEF,
      model: "opus",
      isolation: "worktree",
      run_in_background: true,
    }),
  );
  expect(reason).toContain(
    'spawn again with exactly subagent_type: "workit:implementer", model: "opus", run_in_background: true (description and prompt as written and no isolation)',
  );
  expect(reason).toContain("an implementer works in its brief's WORKTREE");
  expect(
    spawn({
      subagent_type: "workit:implementer",
      prompt: BRIEF,
      model: "opus",
      run_in_background: true,
    }).hookSpecificOutput,
  ).toBeUndefined();
});

test("G an implementer spawn with isolation and no model, W PreToolUse runs, T one deny drops isolation and names the role model", () => {
  const reason = denied(
    spawn({
      subagent_type: "workit:implementer",
      prompt: BRIEF,
      isolation: "worktree",
    }),
  );
  expect(reason).toContain('model: "sonnet"');
  expect(reason).toContain("no isolation");
});

test("G an implementer spawn without a brief, W PreToolUse runs, T it is denied with the two exact commands that make one, also for a single slice (retro 2026-11-07 R3)", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt: "fix the tests",
    model: "opus",
  });
  const reason = denied(out);
  expect(reason).toContain("`workit fanout worktree create <slice>`");
  expect(reason).toContain("`workit fanout brief <slice>`");
  expect(reason).toContain("Even for one slice");
  expect(reason).toContain("SPAWN line");
});

test("G an implementer prompt that points at its brief (WORKER, TIER, TIMEBOX and WORKTREE lines, render the rest), W PreToolUse runs, T it is accepted as a brief", () => {
  const out = spawn({
    subagent_type: "workit:implementer",
    prompt:
      "WORKER: slice\nTIER: standard\nTIMEBOX: 30 minutes, 120 tool calls\nWORKTREE: /w/slice\nRun `workit fanout brief slice` and follow its text exactly.\n",
    model: "opus",
  });
  expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
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

test("G any other spawn type with isolation, W PreToolUse runs, T it is denied with the same args without isolation (retro class 9)", () => {
  for (const subagent_type of [
    "workit:verifier",
    "general-purpose",
    "Explore",
    "Plan",
    undefined,
  ]) {
    const reason = denied(
      spawn({
        subagent_type,
        prompt: "verify it",
        model: "sonnet",
        isolation: "worktree",
      }),
    );
    expect(reason, String(subagent_type)).toContain(
      `exactly ${subagent_type ? `subagent_type: "${subagent_type}", ` : ""}model: "sonnet" (description and prompt as written and no isolation)`,
    );
    expect(reason).toContain("runs in your checkout");
  }
});

test("G a verifier spawn with no isolation and a model, W PreToolUse runs, T it is left as written", () => {
  const out = spawn({
    subagent_type: "workit:verifier",
    prompt: "verify it",
    model: "sonnet",
  });
  expect(out.hookSpecificOutput).toBeUndefined();
});

test("G every agent type and either isolation mode, W PreToolUse runs, T isolation never reaches Claude Code and no spawn is rewritten (W2.12, retro 2026-11-07 R1)", () => {
  const types = [
    "workit:implementer",
    "workit:verifier",
    "workit:reviewer",
    "general-purpose",
    "Explore",
    "Plan",
    "fork",
    "claude",
    "claude-code-guide",
    "statusline-setup",
    "someone:else",
    undefined,
  ];
  for (const subagent_type of types)
    for (const isolation of ["worktree", "remote"]) {
      const label = `${String(subagent_type)} ${isolation}`;
      const out = spawn({
        subagent_type,
        prompt: BRIEF,
        model: "sonnet",
        isolation,
      });
      expect(out.hookSpecificOutput?.updatedInput, label).toBeUndefined();
      expect(out.hookSpecificOutput?.permissionDecision, label).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason, label).toContain("no isolation");
    }
});
