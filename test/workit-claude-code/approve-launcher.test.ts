// Host-approval channel through the real launcher: its fast paths answer `{}`
// before the runtime loads, so a `workit approve` call must reach the runtime
// on PreToolUse (the ask) and PostToolUse (the grant); other light commands
// stay on the fast path.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createApprovalRequest } from "@/packages/workit-core/src/approvals/store";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-approve-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const state = path.join(base, "state");
const repo = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: state,
};

const payload = (event: "PreToolUse" | "PostToolUse", command: string) => ({
  hook_event_name: event,
  session_id: "11111111-2222-3333-4444-555555555555",
  transcript_path: "/tmp/x.jsonl",
  cwd: repo,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command, description: "d" },
  tool_use_id: "toolu_approve",
  ...(event === "PostToolUse"
    ? { tool_response: { stdout: "", stderr: "", interrupted: false } }
    : {}),
});

type Output = { hookSpecificOutput?: { permissionDecision?: string } };

test("Given a stored request, When the launcher sees workit approve <id> on PreToolUse and PostToolUse, Then the runtime asks and records the grant; ls stays on the fast path", () => {
  const saved = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = state;
  let id: string;
  try {
    id = createApprovalRequest(
      {
        kind: "first-push",
        action: "workit git push origin main",
        target: { repo: "/r/.git", remote: "git@example.com:o/r.git", branch: "main" },
        effect: "creates main on the empty remote",
        subject: { head: "abc123" },
      },
      { session: "s0" },
    ).id;
  } finally {
    if (saved === undefined) delete process.env.WORKIT_STATE_DIR;
    else process.env.WORKIT_STATE_DIR = saved;
  }
  const command = `workit approve ${id}`;
  const pre = runHook(PLUGIN_DIR, payload("PreToolUse", command), env);
  expect(pre.status, pre.stderr).toBe(0);
  expect((pre.json as Output).hookSpecificOutput?.permissionDecision).toBe("ask");
  const post = runHook(PLUGIN_DIR, payload("PostToolUse", command), env);
  expect(post.status, post.stderr).toBe(0);
  expect(existsSync(path.join(state, "approvals", "grants", `${id}.json`))).toBe(true);

  const wrapped = runHook(PLUGIN_DIR, payload("PreToolUse", `FOO=1 ${command}`), env);
  expect((wrapped.json as Output).hookSpecificOutput?.permissionDecision).toBe("deny");
  expect(runHook(PLUGIN_DIR, payload("PreToolUse", "ls -la"), env).json).toEqual({});
  expect(runHook(PLUGIN_DIR, payload("PostToolUse", "ls -la"), env).json).toEqual({});
}, 60_000);

test("Given workit release notes approve or a commit message that says approve, When the launcher classifies PostToolUse, Then it stays on the fast path; workit approve <id> still reaches the runtime", () => {
  // A runtime that cannot start says so on stderr; the fast path never starts it.
  const noRuntime = {
    ...env,
    WORKIT_CLAUDE_RUNTIME: "source",
    WORKIT_BUN: path.join(base, "no-bun"),
  };
  const reached = (command: string) =>
    runHook(PLUGIN_DIR, payload("PostToolUse", command), noRuntime).stderr.includes(
      "hook unavailable",
    );
  for (const command of [
    "workit release notes approve 4.5.0",
    'workit git push --help && echo "approve flow"',
    "workit ledger standing list --approve",
  ])
    expect(reached(command), command).toBe(false);
  for (const command of [
    "workit approve ap_k3m7q2xa",
    "workit --cwd /tmp approve ap_k3m7q2xa",
    "cd /tmp && workit approve ap_k3m7q2xa",
    "FOO=1 workit approve ap_k3m7q2xa",
  ])
    expect(reached(command), command).toBe(true);
}, 60_000);

test("Given a session or token global before the verb, When the launcher classifies workit approve on PreToolUse and PostToolUse, Then the call reaches the runtime", () => {
  const noRuntime = { ...env, WORKIT_CLAUDE_RUNTIME: "source", WORKIT_BUN: path.join(base, "no") };
  const reached = (event: "PreToolUse" | "PostToolUse", command: string) =>
    runHook(PLUGIN_DIR, payload(event, command), noRuntime).stderr.includes("hook unavailable");
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    for (const command of [
      "workit --session=s1 approve ap_k3m7q2xa",
      "workit --token t1 approve ap_k3m7q2xa",
      "workit --token=t1 approve ap_k3m7q2xa",
      "workit --json --session s1 --token=t1 approve ap_k3m7q2xa",
    ])
      expect(reached(event, command), `${event} ${command}`).toBe(true);
  }
  // `release notes approve` is not `workit approve`: PostToolUse records no
  // grant, so it stays on the fast path. PreToolUse sends it on, as it does any
  // text with `workit` and a user-only first word (the user-only gate's own
  // first test, delivery-verbs.ts mayRunUserOnly); `--token` is no CLI global
  // option, so the gate does not read a user-only call there and the runtime
  // answers nothing.
  const call = "workit --token t1 release notes approve 4.5.0";
  expect(reached("PostToolUse", call)).toBe(false);
  expect(reached("PreToolUse", call)).toBe(true);
  const pre = runHook(PLUGIN_DIR, payload("PreToolUse", call), env);
  expect(pre.status, pre.stderr).toBe(0);
  expect((pre.json as Output).hookSpecificOutput?.permissionDecision).toBeUndefined();
  // Without the stray option it is the user-only call: the runtime asks.
  const plain = runHook(
    PLUGIN_DIR,
    payload("PreToolUse", "workit release notes approve 4.5.0"),
    env,
  );
  expect((plain.json as Output).hookSpecificOutput?.permissionDecision).toBe("ask");
}, 60_000);
