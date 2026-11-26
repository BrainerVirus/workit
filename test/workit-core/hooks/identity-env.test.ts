// #883: on hosts whose hooks stamp the agent (Claude Code, Codex), a command
// that sets, unsets or clears an identity variable is denied for every agent,
// so the CLI cannot be made to read no host and take a forged agent id.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  handleHook,
  OPENCODE_DESCRIPTOR,
  type HookInput,
} from "@/packages/workit-core/src/hooks/index";
import type { HostDescriptor } from "@/packages/workit-core/src/hooks/descriptor";
import { PLUGIN_DIR, runHook } from "@/test/workit-claude-code/plugin-helpers";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-identity-env-")));
spawnSync("git", ["init", "-q", "-b", "feature/x", root], { timeout: 30_000 });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const shellPre = (
  command: string,
  agent: string | null,
  descriptor: HostDescriptor = CLAUDE_CODE_DESCRIPTOR,
  host: HookInput["host"] = "claude_code",
  dialect: "posix" | "powershell" = "posix",
) =>
  handleHook(
    {
      host,
      cwd: root,
      session: {
        id: "s-lead",
        agentId: agent,
        agentType: agent ? "general-purpose" : null,
        parentId: agent ? "s-lead" : null,
      },
      permissionMode: "default",
      transcriptPath: null,
      event: { kind: "shell.pre", command, toolUseId: null, toolInput: { command }, dialect },
    },
    { descriptor, addendum: null },
  );
const identityDenied = (decision: ReturnType<typeof shellPre>) =>
  decision.kind === "deny" && decision.reason.includes("workit identity");

const REFUSED = [
  "WORKIT_AGENT_ID=v1 workit check test",
  "WORKIT_HOST= WORKIT_AGENT_ID=v1 workit check test",
  "env -u WORKIT_HOST WORKIT_AGENT_ID=v1 workit check test",
  "env --unset=WORKIT_HOST workit check test",
  "env -uWORKIT_SESSION_ID workit check test",
  "env WORKIT_SESSION_ID=s-other workit check test",
  "env -i PATH=/usr/bin workit check test",
  "env - workit check test",
  "env --ignore-environment workit check test",
  "timeout 60 env -u WORKIT_HOST workit check test",
  "export WORKIT_AGENT_ID=v1; workit check test",
  "unset WORKIT_HOST && workit check test",
  "declare -x WORKIT_SESSION_TOKEN=t",
  "WORKIT_SESSION_ID=x",
  "cd /w && WORKIT_HOST= workit check test",
  "bash -c 'unset WORKIT_HOST; workit check test'",
  // Round 5 (verdict mwxcjy8l): env options read by arity, -S lines, and what Workit cannot read.
  "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -C . -u WORKIT_HOST WORKIT_AGENT_ID=forged workit check test",
  "env -C . -u WORKIT_HOST workit check test",
  "env -C. -u WORKIT_HOST workit check test",
  "env --chdir=. WORKIT_AGENT_ID=x workit check test",
  "env --chdir . WORKIT_AGENT_ID=x workit check test",
  "env -a foo -u WORKIT_HOST workit check test",
  "env -vC . -u WORKIT_HOST workit check test",
  "env -S 'WORKIT_AGENT_ID=x workit check test'",
  "env --split-string='-u WORKIT_HOST workit check test'",
  "V=WORKIT_AGENT_ID; env $V=x workit check test",
  'env "$(printf WORKIT_AGENT_ID=x)" workit check test',
  "env --bogus-opt workit check test",
  "env -Q workit check test",
  "unset $V; workit check test",
  "export $V=x; workit check test",
  // Round 6 (verdict mwxdl7xe): `--` then assignments, `$` in -S, env.exe, wrappers, opaque wrappers.
  "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -- WORKIT_HOST= WORKIT_AGENT_ID=forged workit check test",
  'env -S "$X workit check test"',
  "X='-u WORKIT_HOST'; env -u CLAUDECODE -S \"$X WORKIT_AGENT_ID=forged workit check test\"",
  "env -S 'workit check `id`'",
  "env.exe -u WORKIT_HOST workit check test",
  "/usr/bin/env.exe WORKIT_AGENT_ID=x workit check test",
  "'C:\\Git\\usr\\bin\\env.exe' WORKIT_AGENT_ID=x workit check test",
  "setsid env -u WORKIT_HOST workit check test",
  "ionice -c3 env -u WORKIT_HOST workit check test",
  "stdbuf -o0 env -u WORKIT_HOST workit check test",
  "chrt -f 1 env -u WORKIT_HOST workit check test",
  "taskset -c 0-2 env -u WORKIT_HOST workit check test",
  "sudo WORKIT_AGENT_ID=x workit check test",
  "watch env FOO=1 workit check test",
  "strace -f env -i workit check test",
  "chroot / env FOO=1 workit check test",
  "env FOO=$(date) workit check test",
  // Round 7 (verdict mwxf55h1): built --split-string, busybox/toybox, env inside fringe wrappers, su/script -c.
  'env --split-string="$X WORKIT_AGENT_ID=forged workit check test"',
  'env --split-string="$X workit check test"',
  'env -S"$X workit check test"',
  "busybox env -u WORKIT_HOST workit check test",
  "toybox env WORKIT_AGENT_ID=x workit check test",
  "busybox env -i workit check test",
  "unshare -r env -u WORKIT_HOST workit check test",
  "pkexec env FOO=1 workit check test",
  "nsenter -t 1 env WORKIT_AGENT_ID=x workit check test",
  "docker run x env -u WORKIT_HOST workit check test",
  "run0 env FOO=1 workit check test",
  "su -c 'env -u WORKIT_HOST workit check test' me",
  "su me -c 'WORKIT_AGENT_ID=x workit check test'",
  "script -q -c 'unset WORKIT_HOST; workit check test' /dev/null",
  "runuser --command='export WORKIT_HOST=; workit check test' me",
];

test.each(REFUSED)("`%s` is denied for a subagent and for the lead", (command) => {
  for (const agent of ["v1", null])
    expect(identityDenied(shellPre(command, agent)), `${command} (${agent ?? "lead"})`).toBe(true);
});

test.each([
  ["$env:WORKIT_AGENT_ID = 'v1'; workit check test"],
  ["Remove-Item env:WORKIT_HOST; workit check test"],
  ["[Environment]::SetEnvironmentVariable('WORKIT_SESSION_ID', 'x')"],
])("PowerShell `%s` is denied", (command) => {
  expect(identityDenied(shellPre(command, "v1", undefined, undefined, "powershell"))).toBe(true);
});

test.each([
  ["workit check test"],
  ["workit check --cwd /w lint"],
  ["grep -rn WORKIT_HOST docs"],
  ['echo "WORKIT_SESSION_ID=x is how a terminal declares one"'],
  ["printenv WORKIT_SESSION_ID"],
  ["env | grep WORKIT_"],
  ["env -u CLAUDE_CODE_SUBAGENT_MODEL bun test x.test.ts"],
  ["env -i ls src"],
  ["env -C src ls"],
  ["env -C /home/me/src/workit FOO=$BAR bun test"],
  ["env -u CLAUDECODE claude -p x"],
  ["env FOO=$BAR bun test"],
  ["env --bogus-opt ls"],
  ["unset $V; ls"],
  ["echo workit-notes; env $X ls"],
  ["env -- FOO=1 ls"],
  ["env -S 'FOO=1 ls'"],
  ["setsid env FOO=1 ls"],
  ["watch env FOO=1 ls"],
  ["strace -f workit check test"],
  ["env.exe FOO=1 bun test"],
  ["docker run x env FOO=1 ls"],
  ["unshare -r env FOO=1 ls"],
  ["busybox env FOO=1 ls"],
  ["grep -rn env src; workit check test"],
  ["su -c 'ls' me"],
  ["script -q -c 'workit check test' /dev/null"],
])("`%s` runs: it reads or names an identity variable without changing it", (command) => {
  expect(identityDenied(shellPre(command, "v1"))).toBe(false);
});

test("Given the documented limit (a guard against careless changes, not a sandbox), When `read` sets an identity variable, Then the guard does not read it", () => {
  expect(identityDenied(shellPre('read WORKIT_HOST <<< ""; workit check test', "v1"))).toBe(false);
});

test("Codex is judged like Claude Code; Cursor and OpenCode stamp no agent, so their hooks leave identity variables alone (Cursor's context names the id to prefix)", () => {
  expect(
    identityDenied(
      shellPre("env -u WORKIT_HOST workit check test", "a1", CODEX_DESCRIPTOR, "codex_cli"),
    ),
  ).toBe(true);
  for (const [descriptor, host] of [
    [CURSOR_DESCRIPTOR, "cursor"],
    [OPENCODE_DESCRIPTOR, "opencode"],
  ] as const)
    expect(
      identityDenied(
        shellPre("WORKIT_SESSION_ID=s-lead workit check test", null, descriptor, host),
      ),
    ).toBe(false);
});

test("Given Claude Code's launcher, When the lead's command changes an identity variable, Then it leaves the fast path for the guard; a plain workit call stays fast", () => {
  const env = { WORKIT_CLAUDE_RUNTIME: "source", WORKIT_BUN: path.join(root, "no-bun") };
  const reached = (command: string) =>
    runHook(
      PLUGIN_DIR,
      {
        hook_event_name: "PreToolUse",
        session_id: `s-${crypto.randomUUID()}`,
        transcript_path: "/tmp/x.jsonl",
        cwd: root,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command, description: "d" },
        tool_use_id: "toolu_identity",
      },
      env,
    ).stderr.includes("hook unavailable");
  for (const command of [
    "WORKIT_HOST= workit check test",
    "env -i workit check test",
    "env - workit check test",
    'WORKIT_"HOST"= workit check test',
    "env -C . -u WORKIT_HOST workit check test",
    "env --bogus-opt workit check test",
  ])
    expect(reached(command), command).toBe(true);
  expect(reached("workit check test")).toBe(false);
}, 120_000);
