// #891 review: the set-verdict store (<state>/verdicts/) and every repository
// ledger (<git common dir>/workit/ledger/) are written only by the workit CLI.
// An agent's Edit/Write or shell write to either is denied.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { fixture, tempRoot } from "./hook-fixtures";

const base = mkdtempSync(path.join(tmpdir(), "workit-verdict-guard-"));
const state = path.join(base, "state");
const root = tempRoot("workit-verdict-guard-root-");
const ledger = path.join(root, ".git", "workit", "ledger");
const saved = process.env.WORKIT_STATE_DIR;
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = state;
  mkdirSync(path.join(state, "verdicts", "sets"), { recursive: true });
  mkdirSync(ledger, { recursive: true });
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
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;

const TARGETS = [
  path.join(state, "verdicts", "sets", "ledger.jsonl"),
  path.join(state, "verdicts", "0123abcd", "ledger.jsonl"),
  path.join(ledger, "ledger.jsonl"),
];

test("G the verdict store and a repository ledger, W Claude Code Edit/Write targets them, T denied by the ledger guard", () => {
  for (const file of TARGETS)
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      const out = claude(tool, { file_path: file });
      expect([file, tool, out?.permissionDecision]).toEqual([file, tool, "deny"]);
      expect(out?.permissionDecisionReason).toContain("ledger guard");
    }
  expect(claude("Write", { file_path: path.join(state, "logs", "x.log") })).toBeUndefined();
});

test("G shell writes into the verdict store or a ledger, W Claude Code runs them, T denied; reads pass", () => {
  for (const file of TARGETS)
    for (const command of [
      `echo '{"type":"verdict.set"}' >> ${file}`,
      `printf x | tee -a ${file}`,
      `cp /tmp/x ${file}`,
      `sed -i s/a/b/ ${file}`,
      `rm -rf ${path.dirname(file)}`,
    ])
      expect(claude("Bash", { command })?.permissionDecision, command).toBe("deny");
  expect(claude("Bash", { command: `cat ${TARGETS[0]}` })).toBeUndefined();
  expect(claude("Bash", { command: `wc -l ${TARGETS[2]}` })).toBeUndefined();
});
