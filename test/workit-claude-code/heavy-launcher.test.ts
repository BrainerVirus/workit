// #325 B1: the launcher's fast path answers light commands before the
// runtime loads; a heavy command (`make test`, `npx jest`, `docker build`)
// must reach the heavy-command gate, through the real `node
// bin/workit-hook.mjs` in both runtimes (local pin and installed dist).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { outputProblem, installedPlugin, PLUGIN_DIR, runHook } from "./plugin-helpers";
import { HEAVY_WORDS } from "@/packages/workit-core/src/core/heavy-words";
import { checksConfigFile } from "@/packages/workit-core/src/check-config";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const bin = temp("wk-claude-heavy-bin-");
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const home = temp("wk-claude-heavy-home-");
const env = {
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  WORKFLOW_TOOLKIT_STATE: temp("wk-claude-heavy-state-"),
};

const repo = () => {
  const root = temp("wk-claude-heavy-repo-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  return root;
};

const payload = (cwd: string, command: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "11111111-2222-3333-4444-555555555555",
  transcript_path: "/tmp/x.jsonl",
  cwd,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command, description: "d" },
  tool_use_id: "toolu_1",
});

type Output = { hookSpecificOutput?: { updatedInput?: { command?: string } } };

for (const [label, plugin] of [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const)
  test(`[${label}] Given make test, npx jest and docker build, When the launcher runs, Then each reaches the gate and is rewritten; ls stays on the fast path`, () => {
    const root = repo();
    for (const command of ["make test", "npx jest", "docker build -t app ."]) {
      const run = runHook(plugin(), payload(root, command), env);
      expect(run.status, run.stderr).toBe(0);
      expect(outputProblem("PreToolUse", run.json)).toBeNull();
      expect((run.json as Output).hookSpecificOutput?.updatedInput?.command, command).toBe(
        `workit check --heavy -- ${command}`,
      );
    }
    expect(runHook(plugin(), payload(root, "ls -la"), env).json).toEqual({});
  }, 60_000);

test("Given the launcher's copy of the heavy words, Then it equals core/heavy-words.ts", () => {
  const source = readFileSync(path.join(PLUGIN_DIR, "bin", "workit-hook.mjs"), "utf8");
  const block = /const HEAVY_WORDS = new Set\(\s*\(([\s\S]*?)\)\.split/u.exec(source)?.[1] ?? "";
  const words = [...block.matchAll(/"([^"]*)"/gu)]
    .map((match) => match[1])
    .join("")
    .split(" ");
  expect(words.toSorted()).toEqual([...HEAVY_WORDS].toSorted());
});

test("Given the launcher's repo checks-config path, Then it is the checks-config loader's", () => {
  const source = readFileSync(path.join(PLUGIN_DIR, "bin", "workit-hook.mjs"), "utf8");
  const relative = /const REPO_CHECKS = "([^"]+)";/u.exec(source)?.[1];
  expect(relative && path.join("/repo", relative)).toBe(checksConfigFile("/repo"));
});

test("Given a machine pattern, When its command runs, Then the launcher sends it to the gate", () => {
  const root = repo();
  mkdirSync(env.WORKFLOW_TOOLKIT_STATE, { recursive: true });
  writeFileSync(
    path.join(env.WORKFLOW_TOOLKIT_STATE, "heavy-commands.json"),
    JSON.stringify({ patterns: ["./ci/integration.sh"] }),
  );
  const run = runHook(PLUGIN_DIR, payload(root, "./ci/integration.sh --all"), env);
  expect((run.json as Output).hookSpecificOutput?.updatedInput?.command).toBe(
    "workit check --heavy -- ./ci/integration.sh --all",
  );
});
