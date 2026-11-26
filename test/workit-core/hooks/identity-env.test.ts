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
])("`%s` runs: it reads or names an identity variable without changing it", (command) => {
  expect(identityDenied(shellPre(command, "v1"))).toBe(false);
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
  ])
    expect(reached(command), command).toBe(true);
  expect(reached("workit check test")).toBe(false);
}, 120_000);
