// OpenCode V2: `npx -y @workit-dev/cli …` with `workit` on PATH runs as the
// `workit …` call. execute.before rewrites the shell input, and OpenCode then
// evaluates its permission on that rewritten command, so the npx spelling
// never earns more than the plain workit call would.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeShellBefore, type ShellWorkdirs } from "@/packages/workit-opencode/src/v2/shell";

const saved = { PATH: process.env.PATH, STATE: process.env.WORKIT_STATE_DIR };
const root = mkdtempSync(path.join(os.tmpdir(), "workit-v2-npx-"));
mkdirSync(path.join(root, ".git"));
const bin = mkdtempSync(path.join(os.tmpdir(), "workit-v2-npx-bin-"));
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const empty = mkdtempSync(path.join(os.tmpdir(), "workit-v2-npx-empty-"));
const state = mkdtempSync(path.join(os.tmpdir(), "workit-v2-npx-state-"));
beforeEach(() => {
  process.env.PATH = bin;
  process.env.WORKIT_STATE_DIR = state;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.STATE === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = saved.STATE;
});
afterAll(() => {
  for (const dir of [root, bin, empty, state]) rmSync(dir, { recursive: true, force: true });
});

const before = (command: string) => {
  const event = { tool: "shell", sessionID: "ses_1", id: "call_1", input: { command } };
  const workdirs: ShellWorkdirs = new Map();
  observeShellBefore(root, event, workdirs);
  return { command: event.input.command, workdirs };
};

test.each([
  ["npx -y @workit-dev/cli git commit -m x -- a.ts", "workit git commit -m x -- a.ts"],
  ["npx @workit-dev/cli@1.7.0 git status", "workit git status"],
  ["cd /tmp/wt && npx --yes @workit-dev/cli git status", "workit git --cwd /tmp/wt status"],
])("`%s` runs as `%s`", (command, call) => {
  const run = before(command);
  expect(run.command).toBe(call);
  expect(run.workdirs.get("ses_1")).toBe(root);
});

test.each([
  ["npx -y cowsay hi"],
  [`workit git commit -m "npx -y @workit-dev/cli git status" -- a.ts`],
  ["npx -y @workit-dev/cli git status && npx -y @workit-dev/cli git log"],
])("`%s` is left as typed", (command) => {
  expect(before(command).command).toBe(command);
});

test("without workit on PATH the npx call runs as typed", () => {
  process.env.PATH = empty;
  const command = "npx -y @workit-dev/cli git status";
  expect(before(command).command).toBe(command);
});
