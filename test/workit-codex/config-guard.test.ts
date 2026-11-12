// The Codex hook entry answers quietly, before the runtime loads, for shell
// commands that cannot matter. A shell write to the config dir's
// workspaces.json must reach the runtime, whose write gate denies it.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/launcher.ts");
const base = mkdtempSync(path.join(tmpdir(), "wk-codex-config-guard-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const bin = path.join(base, "bin");
const root = path.join(base, "repo");
mkdirSync(bin, { recursive: true });
mkdirSync(path.join(home, ".config", "workit"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "feature/x", root]);
writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "workit"), 0o755);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  WORKIT_STATE_DIR: path.join(home, "state"),
};
for (const key of ["XDG_CONFIG_HOME", "WORKIT_CONFIG", "WORKIT_CONFIG_DIR"]) delete env[key];

const run = (command: string, extra: NodeJS.ProcessEnv = {}) => {
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
    env: { ...env, ...extra },
  });
  expect(child.status, child.stderr).toBe(0);
  return (
    JSON.parse(child.stdout) as {
      hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
};

test("Given a shell write to the config file, When the Codex hook runs, Then it is denied rather than answered quietly", () => {
  const dir = path.join(home, ".config", "workit");
  for (const command of [
    `echo '{}' > ${dir}/workspaces.json`,
    "sed -i s/false/true/ ~/.config/workit/workspaces.json",
    `cp /tmp/x.json ${dir}/`,
  ]) {
    const out = run(command);
    expect(out.permissionDecision, command).toBe("deny");
    expect(out.permissionDecisionReason).toContain("workit grant set <ws>");
  }
  const wc = path.join(base, "wc");
  expect(run(`cp /tmp/x.json ${wc}/`, { WORKIT_CONFIG: wc }).permissionDecision).toBe("deny");
  expect(run(`cat ${dir}/workspaces.json`).permissionDecision).toBeUndefined();
  expect(run(`echo ok > ${root}/a.txt`).permissionDecision).toBeUndefined();
}, 60_000);
