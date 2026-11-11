// #793: `cd <dir> && workit <verb> … || git …` cannot be rewritten to one
// --cwd call, so the hook denies it and names that one call instead.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cdWorkitSplit } from "@/packages/workit-core/src/hooks/cwd-normalize";
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
    `cd /tmp/wt && workit git commit -m "a || b" -- n.md 2>&1; echo "exit=$?"; git log --oneline -2`,
    `workit git --cwd /tmp/wt commit -m "a || b" -- n.md 2>&1`,
  ],
  ["cd /tmp/wt && workit git status && workit git push", "workit git --cwd /tmp/wt status"],
  ["cd /tmp/wt && workit pr status | tail -3 || true", "workit pr --cwd /tmp/wt status | tail -3"],
])("`%s` splits to the one call `%s`", (command, call) => {
  expect(cdWorkitSplit(command)).toBe(call);
});

test.each([
  ["cd /tmp/wt && workit git commit -m x -- n.md 2>&1 | tail -3"],
  ["cd /tmp/wt && git status && git log"],
  ["cd $W && workit git commit -m x || git commit -m x"],
  ["workit git --cwd /tmp/wt commit -m x || git commit -m x"],
  ["cd /tmp/wt && workit git commit -m $(cat f) || git commit"],
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
