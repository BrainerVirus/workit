// #864 through the real launcher: its PreToolUse fast path answers `{}`
// before the runtime loads, so a `workit youtrack` write (the ask on the
// action itself) and any text naming an approval ticket (the replay deny)
// must reach the runtime; a YouTrack read stays on the fast path.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-inline-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
// A runtime that cannot start says so on stderr; the fast path never starts it.
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: path.join(base, "state"),
  WORKIT_CLAUDE_RUNTIME: "source",
  WORKIT_BUN: path.join(base, "no-bun"),
};

const reached = (tool: string, input: Record<string, unknown>) =>
  runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd: repo,
      permission_mode: "auto",
      tool_name: tool,
      tool_input: input,
      tool_use_id: "toolu_inline",
    },
    env,
  ).stderr.includes("hook unavailable");

test("Given a workit youtrack write, When the launcher classifies PreToolUse, Then the call reaches the runtime; a read stays on the fast path", () => {
  for (const command of [
    "workit youtrack note X-1 --file note.md",
    "workit youtrack time X-1 --minutes 30",
    "workit youtrack update X-1 --state Done",
    "workit --json youtrack create --project X --summary s",
    "bash -c 'workit youtrack meeting X-1 --minutes 30 --text standup'",
  ])
    expect(reached("Bash", { command }), command).toBe(true);
  expect(reached("Bash", { command: "workit youtrack show X-1" })).toBe(false);
}, 60_000);

test("Given text naming an approval ticket, When the launcher classifies a Bash, Write or Edit call, Then it reaches the runtime", () => {
  expect(reached("Bash", { command: "WORKIT_APPROVAL_TICKET=abc ./post.sh" })).toBe(true);
  expect(reached("Bash", { command: "echo $WORKIT_APPROVAL_UNASKED" })).toBe(true);
  const file = path.join(repo, "post.sh");
  expect(reached("Write", { file_path: file, content: "WORKIT_APPROVAL_TICKET=abc x" })).toBe(true);
  expect(
    reached("Edit", { file_path: file, old_string: "a", new_string: 'WORKIT_APPROVAL_"TICKET"=1' }),
  ).toBe(true);
}, 60_000);
