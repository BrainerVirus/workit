// Round 2 item 5 through Claude Code's real launcher: in a repo with no Workit
// task store, every edit and every shell write reaches the runtime (its guards
// judge a write in any checkout), and so does any text that may run a
// user-only Workit call; reads, fd duplications and `>/dev/null` stay on the
// fast path.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-reach-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
spawnSync("git", ["init", "-q", "-b", "feature/x", repo], { timeout: 20_000 });
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: path.join(base, "state"),
  WORKIT_CONFIG_DIR: path.join(base, "config"),
  // A runtime that cannot start fails open loudly: the fast path never starts it.
  WORKIT_CLAUDE_RUNTIME: "source",
  WORKIT_BUN: path.join(base, "no-bun"),
};

const reached = (tool_name: string, tool_input: Record<string, unknown>) => {
  const run = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd: repo,
      permission_mode: "default",
      tool_name,
      tool_input,
      tool_use_id: "toolu_reach",
    },
    env,
  );
  expect(run.status, run.stderr).toBe(0);
  return run.stderr.includes("hook unavailable");
};
const shell = (command: string) => reached("Bash", { command, description: "d" });

const WRITES = [
  "mkdir out",
  "rm -f a.txt",
  "cp a.txt b.txt",
  "echo x | tee a.txt",
  "sed -i s/a/b/ a.txt",
  "echo x > a.txt",
  "echo x >> a.txt",
  "ls 2>&1 > a.txt",
  "python3 gen.py",
  "node gen.mjs",
  "bash gen.sh",
];
const READS = [
  "ls",
  "cat a.txt",
  "rg needle src",
  "ls 2>&1 | tail -5",
  "ls >/dev/null",
  "ls > /dev/null 2>&1",
  "ls >&2",
];

test("G a repo with no task store, W an agent makes an edit or a shell write, T the launcher sends it to the runtime", () => {
  const file = path.join(repo, "a.ts");
  for (const [tool, input] of [
    ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
    ["Write", { file_path: file, content: "x" }],
    ["MultiEdit", { file_path: file, edits: [] }],
    ["NotebookEdit", { notebook_path: path.join(repo, "a.ipynb"), new_source: "x" }],
  ] as const)
    expect(reached(tool, input), tool).toBe(true);
  for (const command of WRITES) expect(shell(command), command).toBe(true);
}, 120_000);

test("G a repo with no task store, W an agent reads, duplicates an fd or writes to /dev/null, T the launcher answers on its fast path", () => {
  for (const command of READS) expect(shell(command), command).toBe(false);
  expect(reached("Read", { file_path: path.join(repo, "a.ts") })).toBe(false);
}, 120_000);

test("G any text with `workit` and a user-only first word, W the launcher reads it, T it goes to the runtime; other workit calls stay fast", () => {
  for (const command of [
    "workit setup --yes",
    "env -u CLAUDECODE workit setup --yes",
    "AI_AGENT=1 workit uninstall --yes",
    "workit --json install --hosts=cursor --yes",
    "workit workspace seal",
    "workit grant set ws merge=true",
    "workit help setup",
  ])
    expect(shell(command), command).toBe(true);
  for (const command of ["workit task status", "workit doctor", "echo setup grant"])
    expect(shell(command), command).toBe(false);
}, 120_000);
