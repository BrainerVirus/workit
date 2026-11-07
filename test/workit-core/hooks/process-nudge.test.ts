// `pkill -f <pattern>` matches the command line of the shell that runs it and
// kills that shell (exit 144): the hook nudges to the bracketed form, never denies.
import { expect, test } from "bun:test";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { tempRoot } from "./hook-fixtures";

const bash = (command: string) => {
  const out = dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "s-pkill",
    cwd: tempRoot("workit-pkill-"),
    tool_name: "Bash",
    tool_input: { command },
  }).json as {
    hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
  };
  return out.hookSpecificOutput ?? {};
};

test("pkill -f workit nudges to pgrep -f '[w]orkit' and does not deny", () => {
  const out = bash("pkill -f workit");
  expect(out.permissionDecision).not.toBe("deny");
  expect(out.additionalContext).toContain("pgrep -f '[w]orkit'");
});

test("a bracketed pattern, pkill without -f and other tools get no nudge", () => {
  for (const command of ["pkill -f '[w]orkit'", "pkill workit", "pgrep -f workit", "echo hi"])
    expect(bash(command).additionalContext ?? "").not.toContain("pgrep -f");
});
