// #292: an agent's tool call that writes under <state>/issued*/ is denied on
// every host, so an issued session id or token cannot be forged by hand.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { underIssued } from "@/packages/workit-core/src/hooks/write-gate";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const base = mkdtempSync(path.join(tmpdir(), "workit-issued-guard-"));
const state = path.join(base, "state");
const root = tempRoot("workit-issued-guard-root-");
const saved = process.env.WORKFLOW_TOOLKIT_STATE;
beforeAll(() => {
  process.env.WORKFLOW_TOOLKIT_STATE = state;
  mkdirSync(path.join(state, "issued", "lead"), { recursive: true });
});
afterAll(() => {
  if (saved === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = saved;
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const claude = (toolName: string, toolInput: Record<string, unknown>) =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-write", root, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;

const opencode = (action: string, resources: string[]) => {
  const event = { action, resources, effect: "allow", message: undefined as string | undefined };
  evaluateShellPermission(root, event);
  return event;
};

const shellCommands = (dir: string) => [
  `echo forged > ${dir}/lead/abc`,
  `cp /tmp/x ${dir}/lead/abc`,
  `mv /tmp/x ${dir}/lead/abc`,
  `echo forged | tee ${dir}/lead/abc`,
  `sed -i s/a/b/ ${dir}/lead/abc`,
  `rm -rf ${dir}`,
  `cd ${dir}/lead && touch abc`,
  `workit check --name x -- bash -c 'echo forged > ${dir}/lead/abc'`,
];

test("G issued and issued-tokens dirs, W Claude Code Edit/Write targets them, T denied with a reason", () => {
  for (const dir of ["issued", "issued-tokens"])
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      const out = claude(tool, { file_path: path.join(state, dir, "lead", "abc") });
      expect(out?.permissionDecision).toBe("deny");
      expect(out?.permissionDecisionReason).toContain("issued-registry guard");
    }
  expect(claude("Write", { file_path: path.join(state, "logs", "x.log") })).toBeUndefined();
  expect(claude("Write", { file_path: path.join(root, "src", "a.ts") })).toBeUndefined();
});

test("G shell writes into the issued dirs, W Claude Code runs them bare or under workit check, T every one is denied", () => {
  for (const dir of ["issued", "issued-tokens"])
    for (const command of shellCommands(path.join(state, dir)))
      expect(claude("Bash", { command })?.permissionDecision, command).toBe("deny");
  expect(claude("Bash", { command: `ls ${state}/issued` })).toBeUndefined();
  expect(claude("Bash", { command: `cat ${state}/issued/lead/abc` })).toBeUndefined();
  expect(claude("Bash", { command: `echo ok > ${state}/logs/x.log` })).toBeUndefined();
  expect(claude("Bash", { command: "workit check test" })).toBeUndefined();
});

test("G the state dir under ~, W a shell writes through ~ or $HOME, T denied", () => {
  const home = path.join(base, "home");
  const prior = { HOME: process.env.HOME, state: process.env.WORKFLOW_TOOLKIT_STATE };
  try {
    process.env.HOME = home;
    process.env.WORKFLOW_TOOLKIT_STATE = path.join(home, "st");
    mkdirSync(path.join(home, "st", "issued"), { recursive: true });
    for (const target of ["~/st/issued/x", "$HOME/st/issued-tokens/x"])
      expect(claude("Bash", { command: `echo f > ${target}` })?.permissionDecision).toBe("deny");
    for (const dir of ["~/st", "$HOME/st", "${HOME}/st"])
      expect(
        claude("Bash", { command: `cd ${dir} && touch issued-tokens/z` })?.permissionDecision,
        dir,
      ).toBe("deny");
  } finally {
    process.env.HOME = prior.HOME;
    process.env.WORKFLOW_TOOLKIT_STATE = prior.state;
  }
});

test("G OpenCode and Pi, W edits and shell writes hit the issued dirs, T both deny", () => {
  const file = path.join(state, "issued-tokens", "lead", "abc");
  expect(opencode("edit", [file]).effect).toBe("deny");
  expect(opencode("shell", [`echo f > ${file}`]).effect).toBe("deny");
  expect(opencode("shell", [`echo f > ${state}/logs/x`]).effect).toBe("allow");
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  expect(
    enforceToolPolicy({ toolName: "write", input: { path: file } } as never, ctx),
  ).toMatchObject({ block: true, reason: expect.stringContaining("issued-registry guard") });
  expect(
    enforceToolPolicy({ toolName: "bash", input: { command: `rm ${file}` } } as never, ctx),
  ).toMatchObject({ block: true });
});

test("G Windows-shaped state and targets, W matched on any OS, T separators, case, drive form and short names do not hide the registry", () => {
  const winState = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wk\\state";
  const real = (file: string) => file.replace("RUNNER~1", "runneradmin");
  const hit = (target: string, cwd = "C:\\work") =>
    underIssued(winState, cwd, target, "win32", real);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wk\\state\\issued\\lead\\abc")).toBe(true);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wk\\state\\issued/lead/abc")).toBe(true);
  expect(hit("c:/users/runneradmin/appdata/local/temp/wk/STATE/Issued-Tokens/x")).toBe(true);
  expect(hit("/c/Users/RUNNER~1/AppData/Local/Temp/wk/state/issued/x")).toBe(true);
  expect(hit("lead\\abc", "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wk\\state\\issued")).toBe(
    true,
  );
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\wk\\state\\logs\\x.log")).toBe(false);
  expect(hit("C:\\work\\issued\\x")).toBe(false);
  expect(underIssued("/s/state", "/w", "/s/state/issued/x", "linux")).toBe(true);
  expect(underIssued("/s/state", "/w", "/s/State/issued/x", "linux")).toBe(false);
});
