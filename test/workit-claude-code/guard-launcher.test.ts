// The launcher's fast paths answer `{}` before the runtime loads. A shell
// write that names the default state dir's approvals registry, however it is
// spelled, must reach the runtime, whose write gate denies it, even in a repo
// with no task store (#818).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-guard-launcher-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
const state = path.join(base, ".local", "state", "workit");
mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: undefined,
  XDG_STATE_HOME: undefined,
  XDG_CONFIG_HOME: undefined,
  WORKIT_CONFIG: undefined,
  WORKIT_CONFIG_DIR: undefined,
};

type Output = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
const decide = (toolName: string, toolInput: Record<string, unknown>) => {
  const run = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd: repo,
      permission_mode: "default",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "toolu_guard",
    },
    env,
  );
  expect(run.status, run.stderr).toBe(0);
  return (run.json as Output).hookSpecificOutput;
};

test("Given a repo with no task store, When a shell write or an edit names the default approvals dir in any spelling, Then the launcher sends it to the runtime, which denies it", () => {
  for (const command of [
    `echo '{}' > ${state}/approvals/grants/a.json`,
    "echo '{}' > ~/.local/state/workit/approvals/grants/a.json",
    "echo '{}' > $HOME/.local/state/workit/approvals/grants/a.json",
    "cd ~/.local/state/workit && echo '{}' > approvals/grants/a.json",
  ]) {
    const out = decide("Bash", { command });
    expect(out?.permissionDecision, command).toBe("deny");
  }
  const grant = path.join(state, "approvals", "grants", "a.json");
  expect(decide("Write", { file_path: grant, content: "{}" })?.permissionDecision).toBe("deny");
  expect(decide("Bash", { command: "ls ~/.local/state/workit/approvals" })).toBeUndefined();
  expect(decide("Bash", { command: "echo ok > notes/approvals.txt" })).toBeUndefined();
}, 60_000);
