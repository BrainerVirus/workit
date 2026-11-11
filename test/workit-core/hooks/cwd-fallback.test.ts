// #793: `cd <dir> && workit <verb> … || git …` cannot be rewritten to one
// --cwd call, so the hook denies it and names that one call instead.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cdWorkitSplit, cwdRewrite } from "@/packages/workit-core/src/hooks/cwd-normalize";
import {
  claudeCodeAdapter,
  codexAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-cwd-fallback-")));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  return root;
};
const pre = (adapter: typeof claudeCodeAdapter, command: string) =>
  dispatchHook(adapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: repo(),
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "run it" },
    tool_use_id: "toolu_1",
  }).json as {
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
      updatedInput?: Record<string, unknown>;
    };
  };

const FALLBACK = `cd /tmp/wt && workit git commit -m "docs: notes" -- notes.md 2>&1 || git commit -m "docs: notes" -- notes.md`;
const ONE_CALL = `workit git --cwd /tmp/wt commit -m "docs: notes" -- notes.md 2>&1`;

test.each([
  [FALLBACK, ONE_CALL],
  [
    `cd /tmp/wt && workit git commit -m "a || b" -- n.md 2>&1; git commit -m "a || b" -- n.md`,
    `workit git --cwd /tmp/wt commit -m "a || b" -- n.md 2>&1`,
  ],
  ["cd /tmp/wt && workit git push || git push origin HEAD", "workit git --cwd /tmp/wt push"],
  [
    "cd /tmp/wt && workit git commit -m x -- n.md || git add n.md && git commit -m x",
    "workit git --cwd /tmp/wt commit -m x -- n.md",
  ],
  [
    "cd /tmp/wt && workit git status; git -C /tmp/wt switch main",
    "workit git --cwd /tmp/wt status",
  ],
  ["cd /tmp/wt && workit git status || git branch -D old", "workit git --cwd /tmp/wt status"],
])("`%s` splits to the one call `%s`", (command, call) => {
  expect(cdWorkitSplit(command)).toBe(call);
});

// Only a raw mutating git fallback after `||` or `;` is denied; these ran before #793 and still do.
test.each([
  ["cd /tmp/wt && workit git commit -m x -- n.md 2>&1 | tail -3"],
  ["cd /tmp/wt && git status && git log"],
  ["cd $W && workit git commit -m x || git commit -m x"],
  ["workit git --cwd /tmp/wt commit -m x || git commit -m x"],
  ["cd /tmp/wt && workit git commit -m $(cat f) || git commit"],
  ["cd /a && workit git status && workit git log"],
  ["cd /a && workit check lint && workit check test"],
  ["cd /a && workit git status && echo done"],
  ["cd /a && workit git status; echo $?"],
  ["cd /a && workit git status | tee out.txt"],
  ["cd /a && workit git status 2>&1 || echo no"],
  ["cd /a && workit git commit -m x && git log | head"],
  ["cd /a && workit git status\nworkit git log"],
  ["cd /a && workit git status || git log --oneline -3"],
  ["cd /a && workit git status; git branch --show-current"],
  ["cd /a && workit git status || git stash list"],
  ["cd /a && workit git commit -m x && git commit -m y"],
])("`%s` is not a split", (command) => {
  expect(cdWorkitSplit(command)).toBeNull();
});

test("Claude Code denies the fallback chain and names the one --cwd call", () => {
  const output = pre(claudeCodeAdapter, FALLBACK).hookSpecificOutput;
  expect(output?.permissionDecision).toBe("deny");
  expect(output?.permissionDecisionReason).toContain(ONE_CALL);
  expect(output?.permissionDecisionReason).toContain("one workit verb per call");
});

test("Codex denies the fallback chain the same way", () => {
  expect(JSON.stringify(pre(codexAdapter, FALLBACK))).toContain(
    JSON.stringify(ONE_CALL).slice(1, -1),
  );
});

test("a rewritable cd chain is still rewritten, not denied", () => {
  const output = pre(
    claudeCodeAdapter,
    "cd /tmp/wt && workit git commit -m x -- n.md",
  ).hookSpecificOutput;
  expect(output?.permissionDecision).toBeUndefined();
  expect(output?.updatedInput?.command).toBe("workit git --cwd /tmp/wt commit -m x -- n.md");
});

// The Haiku 5.5 bench call: a `cd` before a workit call that already names the same --cwd.
test.each([
  [
    `cd /tmp/wt && workit git commit --cwd /tmp/wt -m "docs: notes" -- notes.md 2>&1`,
    `workit git commit --cwd /tmp/wt -m "docs: notes" -- notes.md 2>&1`,
  ],
  [
    `cd "/tmp/my wt" && workit git --cwd "/tmp/my wt" status`,
    `workit git --cwd "/tmp/my wt" status`,
  ],
])("a redundant cd in `%s` is dropped", (command, expected) => {
  expect(cwdRewrite(command)).toBe(expected);
});

test.each([
  ["cd /tmp/a && workit git commit --cwd /tmp/b -m x"],
  ["cd /tmp/a && workit git commit --cwd /tmp/a -m x; rm y"],
])("`%s` keeps its cd", (command) => {
  expect(cwdRewrite(command)).toBeNull();
});
