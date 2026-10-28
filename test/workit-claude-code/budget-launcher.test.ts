// Retro P9 through the real `node bin/workit-hook.mjs`: the lead's spawn
// queues the brief's tool-call budget, SubagentStart binds it, the launcher
// counts every call (fast-path Reads included) and only the Nth loads the
// runtime, whose PreToolUse answer carries the line once.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { outputProblem, PLUGIN_DIR, runHook } from "./plugin-helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const home = temp("wk-claude-budget-home-");
const env = {
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  WORKFLOW_TOOLKIT_STATE: temp("wk-claude-budget-state-"),
};
const SESSION = "11111111-2222-3333-4444-666666666666";

const base = (cwd: string) => ({
  session_id: SESSION,
  transcript_path: "/tmp/x.jsonl",
  cwd,
  permission_mode: "default",
});

const context = (json: unknown): string | undefined =>
  (json as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;

test("Given a spawn whose brief names 3 tool calls, When the subagent reads 6 times, Then the 3rd and 6th answers carry the line and the rest stay {}", () => {
  const root = temp("wk-claude-budget-repo-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  const spawn = runHook(
    PLUGIN_DIR,
    {
      ...base(root),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: "toolu_spawn",
      tool_input: {
        description: "slice",
        subagent_type: "general-purpose",
        model: "sonnet",
        prompt:
          "GOAL: x\nTIMEBOX: 30 minutes, 3 tool calls; past it without a new commit you will be replaced\n",
      },
    },
    env,
  );
  expect(spawn.status, spawn.stderr).toBe(0);
  const start = runHook(
    PLUGIN_DIR,
    {
      ...base(root),
      hook_event_name: "SubagentStart",
      agent_id: "agent-b",
      agent_type: "general-purpose",
    },
    env,
  );
  expect(start.status, start.stderr).toBe(0);
  const answers = [];
  for (let i = 1; i <= 6; i++) {
    const run = runHook(
      PLUGIN_DIR,
      {
        ...base(root),
        hook_event_name: "PreToolUse",
        agent_id: "agent-b",
        agent_type: "general-purpose",
        tool_name: "Read",
        tool_use_id: `toolu_${i}`,
        tool_input: { file_path: path.join(root, "README.md") },
      },
      env,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(outputProblem("PreToolUse", run.json)).toBeNull();
    answers.push(run.json);
  }
  expect([answers[0], answers[1], answers[3], answers[4]]).toEqual([{}, {}, {}, {}]);
  expect(context(answers[2])).toContain(
    "Tool-call budget reached (3): commit your work, write your report, stop.",
  );
  expect(context(answers[5])).toContain("Tool-call budget reached (6)");
  expect(JSON.stringify(answers)).not.toContain('"deny"');
  const budgetDir = path.join(root, ".git", "workit", "budget");
  expect(readdirSync(budgetDir).filter((name) => !name.startsWith("spawns-"))).toHaveLength(2);
  const stop = runHook(
    PLUGIN_DIR,
    {
      ...base(root),
      hook_event_name: "SubagentStop",
      agent_id: "agent-b",
      agent_type: "general-purpose",
      stop_hook_active: false,
    },
    env,
  );
  expect(stop.json).toEqual({});
  expect(readdirSync(budgetDir).filter((name) => !name.startsWith("spawns-"))).toEqual([]);
}, 60_000);

test("Given an implementer spawn the gate denies, When an implementer later starts and reads, Then it carries no budget", () => {
  const root = temp("wk-claude-budget-denied-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  const denied = runHook(
    PLUGIN_DIR,
    {
      ...base(root),
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: "toolu_denied",
      tool_input: {
        description: "slice",
        subagent_type: "workit:implementer",
        model: "opus",
        prompt: "GOAL: x\nTIMEBOX: 30 minutes, 2 tool calls; past it\n",
      },
    },
    env,
  );
  expect(JSON.stringify(denied.json)).toContain('"deny"');
  runHook(
    PLUGIN_DIR,
    {
      ...base(root),
      hook_event_name: "SubagentStart",
      agent_id: "i-1",
      agent_type: "workit:implementer",
    },
    env,
  );
  for (let i = 1; i <= 3; i++) {
    const run = runHook(
      PLUGIN_DIR,
      {
        ...base(root),
        hook_event_name: "PreToolUse",
        agent_id: "i-1",
        agent_type: "workit:implementer",
        tool_name: "Read",
        tool_use_id: `toolu_r${i}`,
        tool_input: { file_path: path.join(root, "README.md") },
      },
      env,
    );
    expect(context(run.json) ?? "").not.toContain("Tool-call budget");
  }
}, 60_000);
