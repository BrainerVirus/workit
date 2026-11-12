// #780 through Claude Code's real launcher: its fast path answers light shell
// commands before the runtime loads, so a raw `ytrack` write, however it is
// wrapped or spelled, must reach the runtime, which denies it naming the
// `workit youtrack …` call or asks for a write no verb covers.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";
import { FAST, POSIX_SHAPES, ROUTED_MENTIONS } from "../workit-core/hooks/ytrack-shapes";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-ytrack-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo], { timeout: 20_000 });
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: path.join(base, "state"),
  WORKIT_CONFIG_DIR: path.join(base, "config"),
};

const decide = (command: string) => {
  const run = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd: repo,
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command, description: "d" },
      tool_use_id: "toolu_ytrack",
    },
    env,
  );
  expect(run.status, run.stderr).toBe(0);
  return (
    run.json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
};

test("G Claude Code's launcher, W raw ytrack writes plain, wrapped or respelled, T the runtime denies naming the workit call or asks; reads stay allowed", () => {
  for (const command of [
    "ytrack issue comment X-1 --body hi",
    "bash -c 'ytrack issue comment X-1 --body hi'",
    "/opt/bin/ytrack issue comment X-1 --body hi",
    'y"t"rack issue comment X-1 --body hi',
  ]) {
    const out = decide(command);
    expect(out?.permissionDecision, command).toBe("deny");
    expect(out?.permissionDecisionReason, command).toContain(
      "`workit youtrack note X-1 --markdown hi`",
    );
  }
  expect(decide("ytrack work-item add X-1 --duration 30m")?.permissionDecisionReason).toContain(
    "`workit youtrack time X-1 --minutes 30`",
  );
  expect(decide("ytrack api /issues/X-1 -X DELETE")?.permissionDecision).toBe("ask");
  // Not a plain command (a host override, a command before the call): the user decides.
  for (const command of [
    "cd /tmp && ytrack issue comment X-1 --body hi",
    "echo hi | ytrack issue comment X-1 --body hi",
  ])
    expect(decide(command)?.permissionDecision, command).toBe("ask");
  expect(decide("YTRACK_HOST=acme ytrack issue comment X-1 --body hi")?.permissionDecision).toBe(
    "ask",
  );
  for (const command of ["ytrack issue view X-1", "ytrack api /users/me --fields login", "ls"])
    expect(decide(command)?.permissionDecision, command).toBeUndefined();
}, 60_000);

test("G Claude Code's launcher, W a command only mentions ytrack in a path or an argument, T it stays on the fast path; every shape the gate decides reaches the runtime", () => {
  // A runtime that cannot start says so on stderr; the fast path never starts it.
  const reached = (command: string) =>
    runHook(
      PLUGIN_DIR,
      {
        hook_event_name: "PreToolUse",
        session_id: "11111111-2222-3333-4444-555555555555",
        transcript_path: "/tmp/x.jsonl",
        cwd: repo,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command, description: "d" },
        tool_use_id: "toolu_ytrack",
      },
      { ...env, WORKIT_CLAUDE_RUNTIME: "source", WORKIT_BUN: path.join(base, "no-bun") },
    ).stderr.includes("hook unavailable");
  for (const command of FAST) expect(reached(command), command).toBe(false);
  // The shared test routes a bare mention; the gate then decides nothing.
  for (const command of ROUTED_MENTIONS) {
    expect(reached(command), command).toBe(true);
    expect(decide(command)?.permissionDecision, command).toBeUndefined();
  }
  for (const command of POSIX_SHAPES) expect(reached(command), command).toBe(true);
}, 60_000);
