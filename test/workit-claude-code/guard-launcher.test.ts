// The launcher's fast paths answer `{}` before the runtime loads. A shell
// write that names the default state dir's approvals registry, however it is
// spelled, must reach the runtime, whose write gate denies it, even in a repo
// with no task store (#818).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLUGIN_DIR, runHook } from "./plugin-helpers";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-claude-guard-launcher-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
const state = path.join(base, ".local", "state", "workit");
mkdirSync(path.join(state, "approvals", "grants"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "feature/x", repo]);
const env = {
  HOME: base,
  CLAUDE_CONFIG_DIR: path.join(base, ".claude"),
  CLAUDE_CODE_ENTRYPOINT: "cli",
  WORKIT_STATE_DIR: undefined,
  XDG_STATE_HOME: undefined,
  XDG_CONFIG_HOME: undefined,
  WORKIT_CONFIG: undefined,
  WORKIT_CONFIG_DIR: undefined,
};

type Output = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};
const decide = (toolName: string, toolInput: Record<string, unknown>, extra = {}) => {
  const run = runHook(
    PLUGIN_DIR,
    {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: "/tmp/x.jsonl",
      cwd: repo,
      permission_mode: "default",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "toolu_guard",
    },
    { ...env, ...extra },
  );
  expect(run.status, run.stderr).toBe(0);
  return (run.json as Output).hookSpecificOutput;
};

test("Given a repo with no task store, When a shell write or an edit names the default approvals dir in any spelling, Then the launcher sends it to the runtime, which denies it", () => {
  for (const command of [
    `echo '{}' > ${state}/approvals/grants/a.json`,
    "echo '{}' > ~/.local/state/workit/approvals/grants/a.json",
    "echo '{}' > $HOME/.local/state/workit/approvals/grants/a.json",
    "cd ~/.local/state/workit && echo '{}' > approvals/grants/a.json",
  ]) {
    const out = decide("Bash", { command });
    expect(out?.permissionDecision, command).toBe("deny");
  }
  const grant = path.join(state, "approvals", "grants", "a.json");
  expect(decide("Write", { file_path: grant, content: "{}" })?.permissionDecision).toBe("deny");
  expect(decide("Bash", { command: "ls ~/.local/state/workit/approvals" })).toBeUndefined();
  expect(decide("Bash", { command: "echo ok > notes/approvals.txt" })).toBeUndefined();
}, 60_000);

test("Given a write whose guarded path shows only once expanded (a glob, an env var), When the hook runs, Then the runtime denies it", () => {
  const wc = path.join(base, "wc");
  for (const [command, extra] of [
    ["cp x.json ~/.con*/wor*/w*.json", {}],
    ["rsync x.json ~/.local/st*/workit/appr*/grants/a.json", {}],
    ["cp x.json $WORKIT_CONFIG/", { WORKIT_CONFIG: wc }],
    ['echo {} > "${XDG_CONFIG_HOME:-$HOME/.config}/workit/work"*', {}],
  ] as Array<[string, Record<string, string>]>)
    expect(decide("Bash", { command }, extra)?.permissionDecision, command).toBe("deny");
}, 60_000);

test("Given a hard link in the repo to a guarded file, When a shell write or a Write names the link, Then the runtime denies it", () => {
  const grant = path.join(state, "approvals", "grants", "linked.json");
  writeFileSync(grant, "{}");
  linkSync(grant, path.join(repo, "linked.json"));
  expect(decide("Bash", { command: "echo '{}' > linked.json" })?.permissionDecision).toBe("deny");
  expect(
    decide("Write", { file_path: path.join(repo, "linked.json"), content: "{}" })
      ?.permissionDecision,
  ).toBe("deny");
  expect(decide("Bash", { command: "echo ok > plain.txt" })).toBeUndefined();
}, 60_000);

test("Given a script file that writes a guarded file, When a shell, an interpreter, `.` or `./x` runs it, Then the hook reads it and denies the run", () => {
  const grant = path.join(state, "approvals", "grants", "s.json").replaceAll("\\", "/");
  writeFileSync(path.join(repo, "forge.sh"), `#!/bin/sh\necho '{}' > ${grant}\n`, { mode: 0o755 });
  writeFileSync(path.join(repo, "forge.mjs"), `require("fs").writeFileSync("${grant}", "{}");\n`);
  writeFileSync(path.join(repo, "forge.pl"), `open(my $f, ">", "${grant}");\n`);
  writeFileSync(path.join(repo, "ok.sh"), "echo hi > out.txt\n");
  for (const command of [
    "bash forge.sh",
    "sh ./forge.sh",
    ". ./forge.sh",
    "./forge.sh",
    "node forge.mjs",
    "perl forge.pl",
  ])
    expect(decide("Bash", { command })?.permissionDecision, command).toBe("deny");
  expect(decide("Bash", { command: "bash ok.sh" })?.permissionDecision).toBeUndefined();
}, 60_000);

test("Given a neutral name that is a symlink to a guarded file or dir, a script run after a wrapper, a quoted marker or an env-var glob, When the hook runs, Then the runtime denies the write", () => {
  const grants = path.join(state, "approvals", "grants");
  writeFileSync(path.join(grants, "b.json"), "{}");
  symlinkSync(path.join(grants, "b.json"), path.join(repo, "presym.json"));
  symlinkSync(grants, path.join(repo, "presymdir"), "junction");
  writeFileSync(
    path.join(repo, "wrapped.sh"),
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
    expect(decide("Bash", { command: command })?.permissionDecision, command).toBe("deny");
  expect(
    decide("Write", { file_path: path.join(repo, "presym.json"), content: "{}" })
      ?.permissionDecision,
  ).toBe("deny");
  expect(decide("Bash", { command: "echo ok > plain-2.txt" })).toBeUndefined();
}, 60_000);
