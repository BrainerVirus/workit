// #435: a `workit …` shell command that fails the same way twice in a row gets
// one line with its unblock; a different command or a success resets it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeShellResult, type ShellAfterEvent } from "@/packages/workit-opencode/src/v2/shell";
import type { FailureMemo } from "@/packages/workit-core/src/hooks/repeat-failure";

const run = (root: string, memo: FailureMemo, command: string, output: string): string => {
  const event: ShellAfterEvent = {
    tool: "shell",
    sessionID: "ses_cli",
    id: `call-${Math.random()}`,
    input: { command },
    status: "completed",
    result: { content: output },
  };
  observeShellResult(root, event, memo);
  return String(event.result?.content);
};

const failed = "workit: unknown flag --nope\n  unblock: workit help git commit\n";

test("Given a failing workit command, When the identical command fails again, Then the output ends with its unblock once per repeat", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-repeat-cli-"));
  try {
    const memo: FailureMemo = new Map();
    const command = "workit git commit --nope";
    expect(run(root, memo, command, failed)).not.toContain("Same call failed twice:");
    expect(run(root, memo, command, failed)).toEndWith(
      "Same call failed twice: workit help git commit",
    );
    expect(run(root, memo, "workit git commit --other", failed)).not.toContain(
      "Same call failed twice:",
    );
    expect(run(root, memo, command, "ok\n")).toBe("ok\n");
    expect(run(root, memo, command, failed)).not.toContain("Same call failed twice:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Given a JSON envelope failure, When repeated, Then the unblock comes from the envelope", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-repeat-cli-"));
  try {
    const memo: FailureMemo = new Map();
    const envelope = `${JSON.stringify({ ok: false, code: "blocked", error: "no", unblock: 'workit pr open --title "x"' })}\n`;
    run(root, memo, "workit pr open --json", envelope);
    expect(run(root, memo, "workit pr open --json", envelope)).toEndWith(
      'Same call failed twice: workit pr open --title "x"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
