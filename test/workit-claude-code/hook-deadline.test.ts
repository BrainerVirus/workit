// Issue #309 on the real launcher, in both runtimes: a hook past its own
// deadline answers Claude a schema-valid result naming the skip and records
// it. WORKIT_HOOK_DEADLINE_MS=1 makes the process start-up spend the budget,
// so nothing sleeps.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHookRuns } from "@/packages/workit-core/src/hooks/hook-runs";
import { fixture, tempRoot } from "@/test/workit-core/hooks/hook-fixtures";
import { installedPlugin, outputProblem, PLUGIN_DIR, runHook } from "./plugin-helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
  const dir =
    prefix === "root"
      ? tempRoot("workit-claude-deadline-")
      : mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const RUNTIMES = [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const;

for (const [runtime, plugin] of RUNTIMES) {
  test(`Given a ${runtime} UserPromptSubmit past the hook deadline, When Claude runs the hook, Then it gets valid output naming the skip and the skip is recorded`, () => {
    const state = scratch("workit-claude-deadline-state-");
    const run = runHook(plugin(), fixture("claude-code", "user-prompt-submit", scratch("root")), {
      WORKIT_HOOK_DEADLINE_MS: "1",
      WORKFLOW_TOOLKIT_STATE: state,
    });
    expect(run.status).toBe(0);
    expect(outputProblem("UserPromptSubmit", run.json)).toBeNull();
    expect(run.json).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "workit context skipped: host under load",
      },
    });
    expect(run.stderr).toContain("past the 1 ms hook deadline");
    const rows = readFileSync(path.join(state, "hook-skips.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toEqual([
      expect.objectContaining({ host: "claude_code", event: "context.turn", outcome: "skip" }),
    ]);
  });

  test(`Given a ${runtime} PreToolUse past the hook deadline, When Claude runs the hook, Then it gets valid PreToolUse output with no permission decision`, () => {
    const run = runHook(
      plugin(),
      fixture("claude-code", "pre-tool-use-bash", scratch("root"), {
        tool_input: { command: "git checkout -b main" },
      }),
      {
        WORKIT_HOOK_DEADLINE_MS: "1",
        WORKFLOW_TOOLKIT_STATE: scratch("workit-claude-deadline-state-"),
      },
    );
    expect(run.status).toBe(0);
    expect(outputProblem("PreToolUse", run.json)).toBeNull();
    expect(run.json).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "workit context skipped: host under load",
      },
    });
  });
}

test("Given the shipped hooks.json, When Claude reads it, Then prompt, tool and subagent hooks allow 15 s and SessionStart and Stop 20 s", () => {
  const hooks = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8"))
    .hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
  const timeouts = Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [
      event,
      groups.flatMap((group) => group.hooks.map((hook) => hook.timeout)),
    ]),
  );
  expect(timeouts).toEqual({
    SessionStart: [20],
    UserPromptSubmit: [15],
    PreToolUse: [15, 15, 15, 15, 15, 15],
    PostToolUse: [15],
    Stop: [20],
    SubagentStart: [15],
  });
});

for (const [runtime, plugin] of RUNTIMES) {
  test(`Given a ${runtime} UserPromptSubmit, When Claude runs the hook, Then the run is recorded for doctor's hook_runs (#433)`, () => {
    const state = scratch("workit-claude-runs-state-");
    const run = runHook(plugin(), fixture("claude-code", "user-prompt-submit", scratch("root")), {
      WORKFLOW_TOOLKIT_STATE: state,
    });
    expect(run.status).toBe(0);
    const runs = readHookRuns(state);
    expect(runs.map((r) => [r.host, r.event, r.count])).toEqual([
      ["claude_code", "UserPromptSubmit", 1],
    ]);
  });
}
