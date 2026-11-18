// #328: the launcher's fast path answers light commands before the runtime
// loads; a dev server must reach the gate (rewritten to `workit run --bg`), and
// a pending RSS notice for the session must load the runtime once, through the
// real `node bin/workit-hook.mjs` in both runtimes (local pin and installed dist).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noticeFile } from "@/packages/workit-core/src/core/procs";
import { installedPlugin, outputProblem, PLUGIN_DIR, runHook } from "./plugin-helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const bin = temp("wk-claude-server-bin-");
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const home = temp("wk-claude-server-home-");
const env = {
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  WORKIT_STATE_DIR: temp("wk-claude-server-state-"),
};
const SESSION = "11111111-2222-3333-4444-555555555555";

const repo = () => {
  const root = temp("wk-claude-server-repo-");
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  return root;
};

const payload = (cwd: string, command: string) => ({
  hook_event_name: "PreToolUse",
  session_id: SESSION,
  transcript_path: "/tmp/x.jsonl",
  cwd,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command, description: "d" },
  tool_use_id: "toolu_1",
});

type Output = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    updatedInput?: { command?: string };
    additionalContext?: string;
  };
};

for (const [label, plugin] of [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const)
  test(`[${label}] Given ng serve, npm run dev and docker compose up, When the launcher runs, Then each reaches the gate and is rewritten to workit run --bg with no permission decision`, () => {
    const root = repo();
    for (const command of ["ng serve --port 4200", "npm run dev", "docker compose up"]) {
      const run = runHook(plugin(), payload(root, command), env);
      expect(run.status, run.stderr).toBe(0);
      expect(outputProblem("PreToolUse", run.json)).toBeNull();
      const output = (run.json as Output).hookSpecificOutput;
      expect(output?.updatedInput?.command, command).toBe(`workit run --bg -- ${command}`);
      expect(output?.permissionDecision, command).toBeUndefined();
    }
  }, 60_000);

for (const [label, plugin] of [
  ["local pin (source)", () => PLUGIN_DIR],
  ["installed (dist)", installedPlugin],
] as const)
  test(`[${label}] Given an RSS notice for the session, When a light command runs, Then the launcher loads the runtime and delivers it once; the next call stays on the fast path`, () => {
    const root = repo();
    const file = noticeFile(env, SESSION);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        session: SESSION,
        notices: [
          {
            id: "p1abc",
            cmd: "ng serve",
            cwd: root,
            rssBytes: 3221225472,
            ceilingBytes: 2147483648,
            restart: "workit run --bg --restart p1abc",
            at: "2026-11-18T00:00:00.000Z",
          },
        ],
      }),
    );
    const first = runHook(plugin(), payload(root, "ls -la"), env);
    expect(first.status, first.stderr).toBe(0);
    expect(outputProblem("PreToolUse", first.json)).toBeNull();
    expect((first.json as Output).hookSpecificOutput?.additionalContext).toContain(
      "`workit run --bg --restart p1abc`",
    );
    expect(existsSync(file)).toBe(false);
    expect(runHook(plugin(), payload(root, "ls -la"), env).json).toEqual({});
  }, 60_000);
