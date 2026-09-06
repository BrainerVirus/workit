import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  handleCodexHook,
  parseCodexHookInput,
} from "../../packages/workit-codex/hooks/workit-hook";

const cwd = () => mkdtempSync(path.join(tmpdir(), "workit-codex-cli-"));

test("CLI SessionStart restores one context for startup, resume, and compact", () => {
  for (const source of ["startup", "resume", "compact"] as const) {
    const root = cwd();
    const result = handleCodexHook({
      hook_event_name: "SessionStart",
      session_id: "session-1",
      cwd: root,
      source,
    });
    expect(result.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
    expect(JSON.stringify(result)).toContain("Workit keeps one accountable lead");
  }
});

test("CLI pre-tool guard parses strictly and denies invalid or outside write targets", () => {
  const root = cwd();
  expect(parseCodexHookInput({ hook_event_name: "PreToolUse" })).toMatchObject({ ok: false });
  const denied = handleCodexHook({
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: /tmp/outside\n*** End Patch" },
  });
  expect(denied.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  });
});

test("headless required decisions report needs_input without fabricated receipts", () => {
  const root = cwd();
  const result = handleCodexHook({
    hook_event_name: "SessionStart",
    session_id: "session-1",
    cwd: root,
    source: "clear",
    needs_user_decision: true,
  });
  expect(JSON.stringify(result)).toContain("needs_input");
  expect(JSON.stringify(result)).not.toContain("receipt");
});
