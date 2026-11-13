// Ruling hook-reach-2026-11-13 through Claude Code's real launcher: with no
// Workit task store a plain write or edit inside the repo is answered on the
// fast path (only a write that may reach a guarded path goes to the registry
// guard: test/workit-core/hooks/write-reach.test.ts); with a store every write
// and every edit reaches the runtime; any text that may run a user-only
// Workit call always does.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-reach-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const plain = path.join(home, "src", "proj", "plain");
const stored = path.join(home, "src", "proj", "stored");
for (const repo of [plain, stored]) {
  spawnSync("git", ["init", "-q", "-b", "feature/x", repo], { timeout: 20_000 });
  writeFileSync(path.join(repo, "a.ts"), "a\n");
}
mkdirSync(path.join(stored, ".git", "workit", "tasks"), { recursive: true });
const env = {
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: path.join(home, ".local", "state", "workit"),
  WORKIT_CONFIG_DIR: path.join(home, ".config", "workit"),
  // A runtime that cannot start fails open loudly: the fast path never starts it.
  WORKIT_CLAUDE_RUNTIME: "source",
  WORKIT_BUN: path.join(base, "no-bun"),
};

const reached = (cwd: string, tool_name: string, tool_input: Record<string, unknown>) => {
  const run = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd,
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
const shell = (cwd: string, command: string) => reached(cwd, "Bash", { command, description: "d" });
const edits = (repo: string) =>
  [
    ["Edit", { file_path: path.join(repo, "a.ts"), old_string: "a", new_string: "b" }],
    ["Write", { file_path: path.join(repo, "a.ts"), content: "x" }],
    ["MultiEdit", { file_path: path.join(repo, "a.ts"), edits: [] }],
    ["NotebookEdit", { notebook_path: path.join(repo, "a.ipynb"), new_source: "x" }],
  ] as const;

const WRITES = (repo: string) => [
  "mkdir out",
  `mkdir -p ${repo}/out`,
  "rm -f a.txt",
  "cp a.txt b.txt",
  "echo x | tee a.txt",
  "echo x > a.txt",
  "echo x >> a.txt",
  `echo x > ${path.join(base, "elsewhere.txt")}`,
  "sed -i s/a/b/ a.txt",
  "ls 2>&1 > a.txt",
  "ls >&2x",
];
const READS = [
  "ls",
  "sed -n 1,5p a.ts",
  "find . -name '*.ts'",
  "awk '{print $1}' a.ts",
  "rg '=>' .",
  "ls 2>&1 | tail",
  "ls >/dev/null",
  "ls >&2",
];

test("G a repo with no task store, W a plain write or edit inside it or a read, T the launcher answers on its fast path", () => {
  for (const command of [...WRITES(plain), ...READS])
    expect(shell(plain, command), command).toBe(false);
  for (const [tool, input] of edits(plain)) expect(reached(plain, tool, input), tool).toBe(false);
}, 180_000);

test("G a repo with a task store, W any write or edit, T the launcher sends it to the runtime; reads stay fast", () => {
  for (const command of WRITES(stored)) expect(shell(stored, command), command).toBe(true);
  for (const [tool, input] of edits(stored)) expect(reached(stored, tool, input), tool).toBe(true);
  // `sed -n` and a quoted `=>` read as writes here (an accepted runtime load).
  for (const command of READS.filter((read) => !/^sed|=>/.test(read)))
    expect(shell(stored, command), command).toBe(false);
}, 180_000);

test("G any text with `workit` and a user-only first word, W the launcher reads it, T it goes to the runtime; other workit calls stay fast", () => {
  for (const command of [
    "workit setup --yes",
    "env -u CLAUDECODE workit setup --yes",
    "AI_AGENT=1 workit uninstall --yes",
    "workit --json install --hosts=cursor --yes",
    "workit workspace seal",
    "workit grant set ws merge=true",
    "workit gr\\\nant set a b=c",
    "work\\\nit setup --yes",
    "workit s$'e'tup --yes",
    "workit help setup",
  ])
    expect(shell(plain, command), command).toBe(true);
  for (const command of ["workit task status", "workit doctor", "echo setup grant"])
    expect(shell(plain, command), command).toBe(false);
}, 180_000);
