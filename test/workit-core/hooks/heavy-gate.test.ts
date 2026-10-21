// Issue #325: a raw heavy command runs under the heavy-check lease on every
// host. Claude Code, OpenCode and Pi rewrite it in the same turn; Codex and
// Cursor deny it with the exact `workit check --heavy -- <cmd>` to run.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { observeShellBefore } from "@/packages/workit-opencode/src/v2/shell";

const saved = { PATH: process.env.PATH, STATE: process.env.WORKFLOW_TOOLKIT_STATE };
let root: string;
let bin: string;
let state: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "workit-heavy-gate-"));
  mkdirSync(path.join(root, ".git"));
  bin = mkdtempSync(path.join(tmpdir(), "workit-heavy-bin-"));
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  state = mkdtempSync(path.join(tmpdir(), "workit-heavy-gate-state-"));
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.WORKFLOW_TOOLKIT_STATE = state;
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.STATE === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = saved.STATE;
  for (const dir of [root, bin, state]) rmSync(dir, { recursive: true, force: true });
});

const claude = (command: string) =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "run it", timeout: 120000 },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput as
    | {
        permissionDecision?: string;
        updatedInput?: Record<string, unknown>;
        additionalContext?: string;
      }
    | undefined;

const codex = (command: string) =>
  handleCodexHook({
    session_id: "session-1",
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  }).hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };

const cursor = (command: string) =>
  handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string; agent_message?: string };

const pi = (command: string) => {
  const input = { command };
  const result = enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  );
  return { result, command: input.command };
};

const opencode = (command: string) => {
  const input = { command };
  observeShellBefore(root, { tool: "shell", sessionID: "ses_1", id: "call-1", input }, new Map());
  return input.command;
};

test("Given a raw `npx jest` on Claude Code, When the shell hook runs, Then the command is rewritten through the lease without a permission decision", () => {
  const output = claude("npx jest");
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput).toEqual({
    command: "workit check --heavy -- npx jest",
    description: "run it",
    timeout: 120000,
  });
  expect(output?.additionalContext).toContain("heavy-check lease");
});

test("Given a raw `npx jest` on OpenCode, When execute.before runs, Then the shell input runs it through the lease", () => {
  expect(opencode("npx jest")).toBe("workit check --heavy -- npx jest");
});

test("Given a raw `npx jest` on Pi, When tool_call runs, Then the input is rewritten in place and the call is not blocked", () => {
  const { result, command } = pi("npx jest");
  expect(result).toBeUndefined();
  expect(command).toBe("workit check --heavy -- npx jest");
});

test("Given a raw `npm run test:ci` on Codex or Cursor, When the hook runs, Then it is denied with the exact workit check --heavy rewrite", () => {
  const codexOutput = codex("npm run test:ci");
  expect(codexOutput.permissionDecision).toBe("deny");
  expect(codexOutput.permissionDecisionReason).toContain(
    "Run exactly: workit check --heavy -- npm run test:ci",
  );
  const cursorOutput = cursor("npm run test:ci");
  expect(cursorOutput.permission).toBe("deny");
  expect(cursorOutput.agent_message).toContain(
    "Run exactly: workit check --heavy -- npm run test:ci",
  );
});

test("Given the rewritten command on Codex or Cursor, When the agent runs it, Then it passes", () => {
  expect(codex("workit check --heavy -- npm run test:ci").permissionDecision).toBeUndefined();
  expect(cursor("workit check --heavy -- npm run test:ci").permission).not.toBe("deny");
});

test("Given a flock-wrapped suite, When the hook runs, Then the whole command runs in bash -c", () => {
  expect(opencode("flock -o x.lock sh -c 'npm test'")).toBe(
    `workit check --heavy -- bash -c 'flock -o x.lock sh -c '\\''npm test'\\'''`,
  );
});

test("Given light commands (ls, git status), When the hook runs on each host, Then nothing changes", () => {
  for (const command of ["ls", "git status"]) {
    const output = claude(command);
    expect(output?.updatedInput).toBeUndefined();
    expect(output?.permissionDecision).toBeUndefined();
    expect(codex(command).permissionDecision).toBeUndefined();
    expect(cursor(command).permission).not.toBe("deny");
    expect(pi(command)).toEqual({ result: undefined, command });
    expect(opencode(command)).toBe(command);
  }
});

test("Given a machine pattern added for `mvn verify`-style commands, When the command runs next, Then it is gated", () => {
  expect(codex("./ci/integration.sh --all").permissionDecision).toBeUndefined();
  writeFileSync(
    path.join(state, "heavy-commands.json"),
    JSON.stringify({ patterns: ["./ci/integration.sh"] }),
  );
  try {
    expect(codex("./ci/integration.sh --all").permissionDecisionReason).toContain(
      "Run exactly: workit check --heavy -- ./ci/integration.sh --all",
    );
    expect(opencode("./ci/integration.sh --all")).toBe(
      "workit check --heavy -- ./ci/integration.sh --all",
    );
  } finally {
    rmSync(path.join(state, "heavy-commands.json"), { force: true });
  }
});

test("Given no workit on PATH, When a heavy command runs, Then the gate stays out of the way", () => {
  const before = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    expect(codex("npx jest").permissionDecision).toBeUndefined();
    expect(opencode("npx jest")).toBe("npx jest");
  } finally {
    process.env.PATH = before;
  }
});
