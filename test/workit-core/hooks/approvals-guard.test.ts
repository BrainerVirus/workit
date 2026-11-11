// Host-approval spec, first deliverable: an agent's tool call that writes
// under <state>/approvals/ is denied on every host whose hooks deny, beside
// the issued-registry guard (#292), so the user's yes cannot be forged by hand.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { underRegistry } from "@/packages/workit-core/src/hooks/write-gate";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const base = mkdtempSync(path.join(tmpdir(), "workit-approvals-guard-"));
const state = path.join(base, "state");
const approvals = path.join(state, "approvals");
const root = tempRoot("workit-approvals-guard-root-");
const saved = process.env.WORKIT_STATE_DIR;
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = state;
  mkdirSync(path.join(approvals, "grants"), { recursive: true });
});
afterAll(() => {
  if (saved === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = saved;
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const claude = (toolName: string, toolInput: Record<string, unknown>) =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-write", root, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).json as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    }
  ).hookSpecificOutput;

const grant = path.join(approvals, "grants", "ap_aaaaaaaa.json");
const writes = [
  `echo '{}' > ${grant}`,
  `cp /tmp/x ${grant}`,
  `mv /tmp/x ${grant}`,
  `echo '{}' | tee ${grant}`,
  `sed -i s/a/b/ ${grant}`,
  `rm -rf ${approvals}`,
  `cd ${approvals}/grants && touch ap_aaaaaaaa.json`,
  `workit check --name x -- bash -c 'echo f > ${grant}'`,
];

test("Given the approvals registry, When Claude Code edits or writes a file in it, Then the approvals guard denies it", () => {
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    const out = claude(tool, { file_path: grant });
    expect(out?.permissionDecision, tool).toBe("deny");
    expect(out?.permissionDecisionReason).toContain("approvals guard");
    expect(out?.permissionDecisionReason).toContain("workit approve <id>");
  }
  // A sibling whose name only starts like it is not the registry.
  expect(claude("Write", { file_path: path.join(state, "approvals-old", "x") })).toBeUndefined();
});

test("Given shell writes into the approvals registry, When Claude Code runs them bare or under workit check, Then every one is denied and reads stay allowed", () => {
  for (const command of writes)
    expect(claude("Bash", { command })?.permissionDecision, command).toBe("deny");
  expect(claude("Bash", { command: `ls ${approvals}` })).toBeUndefined();
  expect(claude("Bash", { command: `cat ${grant}` })).toBeUndefined();
});

test("Given a redirect into the approvals registry, When Codex, Cursor, OpenCode and Pi gate it, Then each denies", () => {
  const command = `echo '{}' > ${grant}`;
  const codex = handleCodexHook({
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
  }).hookSpecificOutput as { permissionDecision?: string };
  expect(codex.permissionDecision).toBe("deny");
  const cursor = handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string };
  expect(cursor.permission).toBe("deny");
  const shell = {
    action: "shell",
    resources: [command],
    effect: "allow",
    message: undefined,
  };
  evaluateShellPermission(root, shell);
  expect(shell.effect).toBe("deny");
  const edit = {
    action: "edit",
    resources: [grant],
    effect: "allow",
    message: undefined,
  };
  evaluateShellPermission(root, edit);
  expect(edit.effect).toBe("deny");
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  expect(
    enforceToolPolicy({ toolName: "write", input: { path: grant } } as never, ctx),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("approvals guard"),
  });
  expect(
    enforceToolPolicy({ toolName: "bash", input: { command: `tee ${grant}` } } as never, ctx),
  ).toMatchObject({ block: true });
});

test("Given Windows-shaped paths, When matched on any OS, Then the approvals dir is found and its siblings are not", () => {
  const winState = "C:\\Users\\me\\AppData\\Local\\workit";
  expect(underRegistry(winState, "C:\\w", `${winState}\\approvals\\grants\\x.json`, "win32")).toBe(
    "approvals",
  );
  expect(
    underRegistry(winState, "C:\\w", "c:/users/ME/appdata/local/workit/Approvals/x", "win32"),
  ).toBe("approvals");
  expect(underRegistry(winState, "C:\\w", `${winState}\\issued\\x`, "win32")).toBe("issued");
  expect(underRegistry(winState, "C:\\w", `${winState}\\logs\\x`, "win32")).toBeNull();
  expect(underRegistry("/s", "/w", "/s/approvals", "linux")).toBe("approvals");
  expect(underRegistry("/s", "/w", "/s/approvalsx/y", "linux")).toBeNull();
});
