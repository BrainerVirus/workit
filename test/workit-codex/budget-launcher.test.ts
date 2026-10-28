// Retro P9 through the real Codex hook process (hooks/launcher.ts under bun):
// a lead's spawn_agent whose brief names 2 tool calls, SubagentStart, then the
// subagent's PreToolUse calls; the 2nd carries the budget line, once.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const home = temp("wk-codex-budget-home-");
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
};

type Output = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };

test("Given a spawn_agent whose brief names 2 tool calls, When the subagent makes 3 calls, Then only the 2nd answer carries the budget line", () => {
  const root = temp("wk-codex-budget-repo-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  const hook = (payload: Record<string, unknown>): Output => {
    const child = spawnSync(process.execPath, [LAUNCHER], {
      input: JSON.stringify({
        session_id: "codex-lead-1",
        cwd: root,
        model: "gpt-5",
        permission_mode: "default",
        transcript_path: null,
        turn_id: "turn-1",
        ...payload,
      }),
      encoding: "utf8",
      env,
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout) as Output;
  };
  hook({
    hook_event_name: "PreToolUse",
    tool_use_id: "spawn-1",
    tool_name: "spawn_agent",
    tool_input: {
      agent_type: "worker",
      message:
        "GOAL: x\nTIMEBOX: 30 minutes, 2 tool calls; past it without a new commit you will be replaced\n",
    },
  });
  hook({ hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "worker" });
  const answers = [1, 2, 3].map((i) =>
    hook({
      hook_event_name: "PreToolUse",
      agent_id: "agent-1",
      agent_type: "worker",
      tool_use_id: `call-${i}`,
      tool_name: "bash",
      tool_input: { command: "ls" },
    }),
  );
  const lines = answers.map((answer) => answer.hookSpecificOutput?.additionalContext ?? "");
  expect(lines[0]).not.toContain("Tool-call budget");
  expect(lines[1]).toContain(
    "Tool-call budget reached (2): commit your work, write your report, stop.",
  );
  expect(lines[2]).not.toContain("Tool-call budget");
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).not.toContain(
    "deny",
  );
}, 60_000);
