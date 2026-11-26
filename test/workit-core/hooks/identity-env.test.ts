// #883: on hosts whose hooks stamp the agent (Claude Code, Codex), a command
// that sets, unsets or clears an identity variable is denied for every agent,
// so the CLI cannot be made to read no host and take a forged agent id.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { identityEnvChange } from "@/packages/workit-core/src/hooks/identity-env";
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
  // Short options glued into one cluster that ends in `c` (#883 follow-up).
  'script -qc "env -u WORKIT_HOST workit check test" /dev/null',
  "script -fqc 'unset WORKIT_HOST; workit check test' /dev/null",
  "script -qec 'WORKIT_AGENT_ID=x workit check test' /dev/null",
  "script -qc'env -u WORKIT_HOST workit check test' /dev/null",
  "su -lc 'env -u WORKIT_HOST workit check test' me",
  "runuser -lc 'export WORKIT_HOST=; workit check test' me",
  // #981: a host's own session variable, set or unset beside a workit call.
  "OPENCODE_SESSION_ID=nobody-7 workit ledger verdict verified --how x",
  "PI_SESSION_ID=nobody-7 workit ledger verdict verified --how x",
  "CODEX_THREAD_ID=nobody-7 workit ledger verdict verified --how x",
  "CLAUDECODE= workit ledger verdict verified --how x",
  "env -u CLAUDE_CODE_ENTRYPOINT workit check test",
  "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT CODEX_THREAD_ID=t workit check test",
  "export OPENCODE_SESSION_ID=x; workit check test",
  "unset CLAUDECODE && workit check test",
  "bash -c 'PI_SESSION_ID=x workit check test'",
  "ssh h env CODEX_THREAD_ID=x workit check test",
];

test.each(REFUSED)("`%s` is denied for a subagent and for the lead", (command) => {
  for (const agent of ["v1", null])
    expect(identityDenied(shellPre(command, agent)), `${command} (${agent ?? "lead"})`).toBe(true);
});

test.each([
  ["$env:WORKIT_AGENT_ID = 'v1'; workit check test"],
  ["Remove-Item env:WORKIT_HOST; workit check test"],
  ["[Environment]::SetEnvironmentVariable('WORKIT_SESSION_ID', 'x')"],
  ["$env:CODEX_THREAD_ID = 'x'; workit check test"],
  ["Remove-Item env:CLAUDECODE; workit check test"],
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
  ['script -qc "ls" /dev/null'],
  ["script -qc 'workit check test' /dev/null"],
  ["su -lc 'ls' me"],
  ["grep CODEX_THREAD_ID src"],
  ["grep -rn OPENCODE_SESSION_ID docs; workit check test"],
  ["printenv CLAUDECODE"],
  ["CODEX_THREAD_ID=t-1 bun test x.test.ts"],
  ["env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDECODE codex exec x"],
])("`%s` runs: it reads or names an identity variable without changing it", (command) => {
  expect(identityDenied(shellPre(command, "v1"))).toBe(false);
});

test("Given the documented limit (a guard against careless changes, not a sandbox), When `read` sets an identity variable, Then the guard does not read it", () => {
  expect(identityDenied(shellPre('read WORKIT_HOST <<< ""; workit check test', "v1"))).toBe(false);
});

test("PowerShell names a host's own session variable without a workit call: it runs", () => {
  expect(
    identityDenied(
      shellPre("$env:CODEX_THREAD_ID = 'x'; codex", "v1", undefined, undefined, "powershell"),
    ),
  ).toBe(false);
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
    "OPENCODE_SESSION_ID=x workit check test",
    "CLAUDECODE= workit check test",
  ])
    expect(reached(command), command).toBe(true);
  expect(reached("workit check test")).toBe(false);
}, 120_000);

// #980: a workit call that moves the state or config dir would read an issued-session
// registry the agent wrote itself; refused on every host, in every spelling the guard reads.
const STATE_VARIABLES = [
  "WORKIT_STATE_DIR",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];
const STATE_SPELLINGS = (name: string): string[] => [
  `${name}=/tmp/alt workit ledger verdict verified --how x`,
  `${name}= workit check test`,
  `export ${name}=/tmp/alt; workit check test`,
  `unset ${name} && workit check test`,
  `env ${name}=/tmp/alt workit check test`,
  `env -u ${name} workit check test`,
  `env --unset=${name} workit check test`,
  `env -S '${name}=/tmp/alt workit check test'`,
  `timeout 60 env ${name}=/tmp/alt workit check test`,
  `cd /w && ${name}=/tmp/alt workit check test`,
  `bash -c 'export ${name}=/tmp/alt; workit check test'`,
  `su -c '${name}=/tmp/alt workit check test' me`,
];
const HOSTS = [
  [CLAUDE_CODE_DESCRIPTOR, "claude_code"],
  [CODEX_DESCRIPTOR, "codex_cli"],
  [CURSOR_DESCRIPTOR, "cursor"],
  [OPENCODE_DESCRIPTOR, "opencode"],
] as const;

test.each(STATE_VARIABLES)(
  "a workit call that sets, unsets or empties %s is denied on every host",
  (name) => {
    for (const command of STATE_SPELLINGS(name))
      for (const [descriptor, host] of HOSTS) {
        const decision = shellPre(command, "v1", descriptor, host);
        expect(identityDenied(decision), `${command} (${host})`).toBe(true);
        if (decision.kind === "deny") expect(decision.reason).toContain(`${name} changed`);
      }
  },
);

test.each([
  ["$env:WORKIT_STATE_DIR = 'C:\\alt'; workit check test"],
  ["$env:LOCALAPPDATA = 'C:\\alt'; workit ledger verdict verified --how x"],
  ["Remove-Item env:HOME; workit check test"],
  ["[Environment]::SetEnvironmentVariable('XDG_STATE_HOME', 'x'); workit check test"],
])("PowerShell `%s` is denied on every host", (command) => {
  for (const [descriptor, host] of HOSTS)
    expect(identityDenied(shellPre(command, "v1", descriptor, host, "powershell")), host).toBe(
      true,
    );
});

test.each([
  ["HOME=/tmp/x bun test"],
  ["export XDG_STATE_HOME=/tmp/x; ls"],
  ["WORKIT_STATE_DIR=/tmp/x bun test test/a.test.ts"],
  ["echo $HOME; workit check test"],
  ["workit check --cwd $HOME/w test"],
  ["cd ~ && workit check test"],
  ["MY_HOME=/x workit check test"],
  ["grep -rn WORKIT_STATE_DIR docs; workit check test"],
  ['echo "HOME=/x"; workit check test'],
])("`%s` runs: it moves no state dir of a workit call", (command) => {
  for (const [descriptor, host] of HOSTS)
    expect(identityDenied(shellPre(command, "v1", descriptor, host)), `${command} (${host})`).toBe(
      false,
    );
});

test("PowerShell that sets a state variable without running workit runs", () => {
  expect(
    identityDenied(
      shellPre("$env:HOME = 'C:\\x'; Get-ChildItem", "v1", undefined, undefined, "powershell"),
    ),
  ).toBe(false);
});

test("Cursor's own prefixed session still runs; the same call with a state dir is denied", () => {
  const cursor = (command: string) =>
    identityDenied(shellPre(command, null, CURSOR_DESCRIPTOR, "cursor"));
  expect(cursor("WORKIT_SESSION_ID=s-lead workit ledger verdict verified --how x")).toBe(false);
  expect(
    cursor(
      "WORKIT_SESSION_ID=s-lead WORKIT_STATE_DIR=/tmp/alt workit ledger verdict verified --how x",
    ),
  ).toBe(true);
});

test("Given Claude Code's launcher, When a workit call names a state variable, Then it leaves the fast path for the guard", () => {
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
        tool_use_id: "toolu_state",
      },
      env,
    ).stderr.includes("hook unavailable");
  for (const command of [
    "WORKIT_STATE_DIR=/tmp/alt workit check test",
    "XDG_STATE_HOME=/tmp/alt workit check test",
    "HOME=/tmp/alt workit check test",
    'bash -c "LOCALAPPDATA=x workit check test"',
    "WORKIT_STATE_DIR=/tmp/alt npx @workit-dev/cli status",
    'WORKIT_STATE_DIR=/tmp/alt "$(command -v workit)" status',
    "HOME+=/x workit check test",
    "unset HOME; /tmp/w status",
  ])
    expect(reached(command), command).toBe(true);
  // A plain workit call stays fast.
  expect(reached("workit check test")).toBe(false);
}, 120_000);

// #980 review round: the CLI under its other names, more spellings, and only real changes.
test.each([
  [
    "WORKIT_STATE_DIR=/x node /n/node_modules/@workit-dev/cli/dist/index.js ledger verdict verified",
  ],
  ["WORKIT_STATE_DIR=/x node packages/workit-cli/dist/index.js status"],
  ["WORKIT_STATE_DIR=/x bun packages/workit-cli/src/main.ts status"],
  ["WORKIT_STATE_DIR=/x npx @workit-dev/cli status"],
  ["WORKIT_STATE_DIR=/x bunx @workit-dev/cli@2 status"],
  ["WORKIT_STATE_DIR=/x workit-cli status"],
  ['WORKIT_STATE_DIR=/x "$(command -v workit)" status'],
  ["WORKIT_STATE_DIR=/x $W status"],
  ["export HOME=/x; $W status"],
  ["HOME+=/x workit check test"],
  ["export HOME+=/x; workit check test"],
  ["HOME=/x xargs workit status < ids"],
  ["HOME=/x find . -exec workit status ;"],
  ['cmd /c "set APPDATA=C:\\alt&& workit status"'],
  ['cmd.exe /C "set "LOCALAPPDATA=C:\\alt" && workit status"'],
  ["HOME=/x; workit status"],
  ["export HOME=/x && workit check lint"],
  ["HOME=/x bash -c 'workit status'"],
])("`%s` is denied: it changes a state dir for a workit run", (command) => {
  for (const [descriptor, host] of HOSTS)
    expect(identityDenied(shellPre(command, "v1", descriptor, host)), `${command} (${host})`).toBe(
      true,
    );
});

test.each([
  ["HOME=/tmp/h npm test && workit check lint"],
  ["workit status; HOME=/tmp/h npm test"],
  ["bash -c 'HOME=/tmp/h npm test; workit status'"],
  ["HOME=/tmp/h ls; workit check test"],
  ["env HOME=/tmp/h ls && workit status"],
])("`%s` runs: the assignment changes only another command's environment", (command) => {
  for (const [descriptor, host] of HOSTS)
    expect(identityDenied(shellPre(command, "v1", descriptor, host)), `${command} (${host})`).toBe(
      false,
    );
});

test.each([
  ['cmd /c "set APPDATA=C:\\alt&& workit status"'],
  ["[Environment]::SetEnvironmentVariable($n, 'x'); workit status"],
  ['[Environment]::SetEnvironmentVariable("$n", "x"); workit status'],
  ['Set-Item -Path "env:$n" -Value x; workit status'],
  [". $PROFILE; workit status"],
  ["${env:HOME} = 'C:\\alt'; workit status"],
  ["$env:APPDATA += ';x'; workit status"],
  ["$env:HOME = 'C:\\alt'; & $w status"],
])("PowerShell `%s` is denied on every host", (command) => {
  for (const [descriptor, host] of HOSTS)
    expect(identityDenied(shellPre(command, "v1", descriptor, host, "powershell")), host).toBe(
      true,
    );
});

test.each([
  ["Write-Host $env:HOME; workit status"],
  ["cd $env:USERPROFILE\\proj; workit check test"],
  ["workit --cwd $env:USERPROFILE\\proj check test"],
  ["if ($env:HOME -eq 'x') { workit status }"],
  ["[Environment]::GetEnvironmentVariable('HOME'); workit status"],
  ["Copy-Item $env:HOME\\a.txt .; workit status"],
  ["$env:HOME = 'C:\\x'; Get-ChildItem"],
])(
  "PowerShell `%s` runs: it reads a state variable, or changes one without a workit run",
  (command) => {
    for (const [descriptor, host] of HOSTS)
      expect(identityDenied(shellPre(command, "v1", descriptor, host, "powershell")), host).toBe(
        false,
      );
  },
);

test.skipIf(process.platform === "win32")(
  "Given a renamed link to the CLI, When a command sets a state variable for it, Then it is denied; a link to anything else runs",
  () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-identity-link-")));
    try {
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "workit"), "#!/bin/sh\n");
      writeFileSync(path.join(bin, "tool"), "#!/bin/sh\n");
      symlinkSync(path.join(bin, "workit"), path.join(dir, "w"));
      symlinkSync(path.join(bin, "tool"), path.join(dir, "t"));
      const denied = (command: string) =>
        identityEnvChange(command, "posix", { identity: true, cwd: dir }) !== null;
      expect(denied(`WORKIT_STATE_DIR=/x ${path.join(dir, "w")} status`)).toBe(true);
      expect(denied("WORKIT_STATE_DIR=/x ./w status")).toBe(true);
      expect(denied("export HOME=/x; ./w status")).toBe(true);
      expect(denied("WORKIT_STATE_DIR=/x ./t status")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// #985 review: identity names follow the same scoping; PowerShell reads never count.
test.each([
  ["OPENCODE_SESSION_ID=x opencode run hi; workit status"],
  ["WORKIT_HOST=claude_code other-tool; workit check test"],
  ["workit status; WORKIT_AGENT_ID=a1 npm test"],
  ["env -u WORKIT_HOST ls && workit status"],
  ["bash -c 'WORKIT_SESSION_ID=x ls; workit status'"],
])("`%s` runs: an identity assignment scoped to another command", (command) => {
  for (const agent of ["v1", null])
    expect(identityDenied(shellPre(command, agent)), `${command} (${agent ?? "lead"})`).toBe(false);
});

test.each([
  ["export WORKIT_HOST=; ls; workit status"],
  ["WORKIT_HOST=; workit status"],
  ["unset WORKIT_SESSION_ID; workit status"],
  ["WORKIT_AGENT_ID=a1 xargs workit status < ids"],
  ["WORKIT_AGENT_ID=a1 npx @workit-dev/cli status"],
  ["WORKIT_AGENT_ID=a1 $W status"],
])("`%s` is denied: the identity change reaches a workit run", (command) => {
  expect(identityDenied(shellPre(command, "v1"))).toBe(true);
});

test.each([
  ["Write-Host $env:CLAUDECODE; workit status"],
  ["if ($env:OPENCODE_SESSION_ID) { workit status }"],
  ["Write-Host $env:WORKIT_HOST; workit status"],
  ["[Environment]::GetEnvironmentVariable('WORKIT_SESSION_ID'); workit status"],
])("PowerShell `%s` runs: it reads an identity variable", (command) => {
  expect(identityDenied(shellPre(command, "v1", undefined, undefined, "powershell"))).toBe(false);
});
