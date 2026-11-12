// The Codex hook entry answers quietly, before the runtime loads, for shell
// commands that cannot matter. A shell write that names the default state
// dir's approvals registry, however it is spelled, must reach the runtime,
// whose write gate denies it (#818).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("Given a write whose guarded path shows only once expanded (a glob, an env var), When the hook runs, Then the runtime denies it", () => {
  const wc = path.join(base, "wc");
  for (const [command, extra] of [
    ["cp x.json ~/.con*/wor*/w*.json", {}],
    ["rsync x.json ~/.local/st*/workit/appr*/grants/a.json", {}],
    ["cp x.json $WORKIT_CONFIG/", { WORKIT_CONFIG: wc }],
    ['echo {} > "${XDG_CONFIG_HOME:-$HOME/.config}/workit/work"*', {}],
  ] as Array<[string, Record<string, string>]>)
    expect(run(command, extra).permissionDecision, command).toBe("deny");
}, 60_000);

test("Given a hard link in the repo to a guarded file, When a shell write names the link, Then it is denied", () => {
  const grant = path.join(state, "approvals", "grants", "linked.json");
  writeFileSync(grant, "{}");
  linkSync(grant, path.join(root, "linked.json"));
  expect(run(`echo '{}' > ${root}/linked.json`).permissionDecision).toBe("deny");
  expect(run(`echo ok > ${root}/plain.txt`).permissionDecision).toBeUndefined();
}, 60_000);

test("Given a script file that writes a guarded file, When a shell, an interpreter, `.` or `./x` runs it, Then the hook reads it and denies the run", () => {
  const grant = path.join(state, "approvals", "grants", "s.json").replaceAll("\\", "/");
  writeFileSync(path.join(root, "forge.sh"), `#!/bin/sh\necho '{}' > ${grant}\n`, { mode: 0o755 });
  writeFileSync(path.join(root, "forge.mjs"), `require("fs").writeFileSync("${grant}", "{}");\n`);
  writeFileSync(path.join(root, "forge.pl"), `open(my $f, ">", "${grant}");\n`);
  writeFileSync(path.join(root, "ok.sh"), "echo hi > out.txt\n");
  for (const command of [
    "bash forge.sh",
    "sh ./forge.sh",
    ". ./forge.sh",
    "./forge.sh",
    "node forge.mjs",
    "perl forge.pl",
  ])
    expect(run(command).permissionDecision, command).toBe("deny");
  expect(run("bash ok.sh").permissionDecision).toBeUndefined();
}, 60_000);

test("Given a neutral name that is a symlink to a guarded file or dir, a script run after a wrapper, a quoted marker or an env-var glob, When the hook runs, Then the runtime denies the write", () => {
  const grants = path.join(state, "approvals", "grants");
  writeFileSync(path.join(grants, "b.json"), "{}");
  symlinkSync(path.join(grants, "b.json"), path.join(root, "presym.json"));
  symlinkSync(grants, path.join(root, "presymdir"), "junction");
  writeFileSync(
    path.join(root, "wrapped.sh"),
    `#!/bin/sh\necho '{}' > ${path.join(grants, "b.json").replaceAll("\\\\", "/")}\n`,
    { mode: 0o755 },
  );
  for (const command of [
    "echo '{}' > presym.json",
    "cp x.json presymdir/new.json",
    "time ./wrapped.sh",
    "exec ./wrapped.sh",
    "sudo ./wrapped.sh",
    "if ./wrapped.sh; then :; fi",
    `echo '{}' > ~/.local/state/work""it/appro""vals/grants/a.json`,
  ])
    expect(run(command).permissionDecision, command).toBe("deny");
  const wc = path.join(base, "wcd");
  mkdirSync(wc, { recursive: true });
  for (const command of [
    "truncate -s 0 $WORKIT_CONFIG_DIR/work*.json",
    "chmod 600 $WORKIT_CONFIG_DIR/w*.json",
  ])
    expect(run(command, { WORKIT_CONFIG_DIR: wc }).permissionDecision, command).toBe("deny");
  expect(run("echo ok > plain-2.txt").permissionDecision).toBeUndefined();
}, 60_000);
