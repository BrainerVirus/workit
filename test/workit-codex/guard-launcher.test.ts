// The Codex hook entry answers quietly, before the runtime loads, for shell
// commands that cannot matter. A shell write that names the default state
// dir's approvals registry, however it is spelled, must reach the runtime,
// whose write gate denies it (#818).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const base = mkdtempSync(path.join(tmpdir(), "wk-codex-guard-launcher-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const bin = path.join(base, "bin");
const root = path.join(base, "repo");
const state = path.join(home, ".local", "state", "workit");
mkdirSync(bin, { recursive: true });
mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "feature/x", root]);
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
};
for (const key of [
  "WORKIT_STATE_DIR",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
])
  delete env[key];

const run = (command: string) => {
  const child = spawnSync(process.execPath, [LAUNCHER], {
    input: JSON.stringify({
      session_id: "session-1",
      cwd: root,
      model: "gpt-5",
      permission_mode: "default",
      transcript_path: null,
      hook_event_name: "PreToolUse",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "bash",
      tool_input: { command },
    }),
    encoding: "utf8",
    env,
  });
  expect(child.status, child.stderr).toBe(0);
  return (
    JSON.parse(child.stdout) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
};

test("Given a shell write that names the default approvals dir in any spelling, When the Codex hook runs, Then it is denied rather than answered quietly", () => {
  for (const command of [
    `echo '{}' > ${state}/approvals/grants/a.json`,
    "echo '{}' > ~/.local/state/workit/approvals/grants/a.json",
    "echo '{}' > $HOME/.local/state/workit/approvals/grants/a.json",
    "cd ~/.local/state/workit && echo '{}' > approvals/grants/a.json",
  ])
    expect(run(command).permissionDecision, command).toBe("deny");
  expect(run("ls ~/.local/state/workit/approvals").permissionDecision).toBeUndefined();
  expect(run(`echo ok > ${root}/approvals.txt`).permissionDecision).toBeUndefined();
}, 60_000);
