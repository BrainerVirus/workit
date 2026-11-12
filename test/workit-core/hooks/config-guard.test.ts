// An agent session cannot raise its own grants or set youtrack.writes by
// writing the config dir's workspaces.json: every host whose hooks deny
// refuses the edit or shell write and names the command the user runs.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { underConfig } from "@/packages/workit-core/src/hooks/write-gate";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-config-guard-")));
const home = path.join(base, "home");
const root = tempRoot("workit-config-guard-root-");
const KEYS = ["HOME", "XDG_CONFIG_HOME", "WORKIT_CONFIG", "WORKIT_CONFIG_DIR", "WORKIT_STATE_DIR"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
const set = (env: Record<string, string | undefined>) => {
  for (const key of KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
};
beforeEach(() => {
  set({});
  // The account-home config dir (grantsDir) under the temp home, never the real one.
  grantsHome.resolve = () => path.join(base, "account");
});
afterEach(() => {
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** The config dir each form resolves to, made on disk. */
const FORMS: Array<{ name: string; env: Record<string, string>; dir: string }> = [
  { name: "default", env: {}, dir: path.join(home, ".config", "workit") },
  {
    name: "XDG_CONFIG_HOME",
    env: { XDG_CONFIG_HOME: path.join(base, "xdg") },
    dir: path.join(base, "xdg", "workit"),
  },
  {
    name: "WORKIT_CONFIG",
    env: { WORKIT_CONFIG: path.join(base, "wc") },
    dir: path.join(base, "wc"),
  },
  {
    name: "account home",
    env: { WORKIT_CONFIG: path.join(base, "wc") },
    dir: path.join(base, "account", ".config", "workit"),
  },
];
for (const form of FORMS) mkdirSync(path.join(form.dir, "rules"), { recursive: true });

type Out = { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
const claude = (toolName: string, toolInput: Record<string, unknown>): Out =>
  (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-write", root, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).json as { hookSpecificOutput?: Out }
  ).hookSpecificOutput;

const expectDeny = (out: Out, label: string) => {
  expect(out?.permissionDecision, label).toBe("deny");
  expect(out?.permissionDecisionReason, label).toContain("workit grant set <ws>");
  expect(out?.permissionDecisionReason, label).toContain("workit workspace set");
};

const shellWrites = (dir: string) => [
  `echo '{}' > ${dir}/workspaces.json`,
  `echo '{}' >> ${dir}/workspaces.json`,
  `echo '{}' | tee ${dir}/workspaces.json`,
  `cp /tmp/x.json ${dir}/workspaces.json`,
  `cp /tmp/workspaces.json ${dir}/`,
  `mv /tmp/x.json ${dir}/workspaces.json`,
  `mv ${dir}/workspaces.json.bak ${dir}/workspaces.json`,
  `sed -i 's/false/true/' ${dir}/workspaces.json`,
  `cd ${dir} && echo '{}' > workspaces.json`,
  `workit check --name x -- bash -c 'echo f > ${dir}/workspaces.json'`,
];

test("G each config dir form, W Claude Code Edit, Write or MultiEdit targets workspaces.json, T denied naming the user's command", () => {
  for (const form of FORMS) {
    set(form.env);
    for (const tool of ["Edit", "Write", "MultiEdit"])
      expectDeny(
        claude(tool, { file_path: path.join(form.dir, "workspaces.json") }),
        `${form.name} ${tool}`,
      );
  }
});

test("G each config dir form, W a shell writes workspaces.json, T every one is denied", () => {
  for (const form of FORMS) {
    set(form.env);
    for (const command of shellWrites(form.dir))
      expectDeny(claude("Bash", { command }), `${form.name}: ${command}`);
  }
});

test("G the default dir under ~, W a shell writes through ~, $HOME, a symlink or a .. path, T denied", () => {
  const link = path.join(base, "link");
  symlinkSync(path.join(home, ".config", "workit"), link);
  for (const command of [
    "echo '{}' > ~/.config/workit/workspaces.json",
    "cp /tmp/x $HOME/.config/workit/workspaces.json",
    `echo '{}' > ${link}/workspaces.json`,
    `echo '{}' > ${home}/.config/workit/rules/../workspaces.json`,
  ])
    expectDeny(claude("Bash", { command }), command);
  expectDeny(claude("Write", { file_path: path.join(link, "workspaces.json") }), "symlink Write");
  expectDeny(
    claude("Edit", { file_path: `${home}/.config/x/../workit/workspaces.json` }),
    ".. Edit",
  );
});

test("G the config file, W a session reads it, runs grant show or workspace list, or writes a file that grants nothing, T nothing is denied", () => {
  const dir = path.join(home, ".config", "workit");
  for (const command of [
    `cat ${dir}/workspaces.json`,
    `grep merge ${dir}/workspaces.json`,
    `jq . ${dir}/workspaces.json > /tmp/out.json`,
    "workit grant show",
    "workit workspace list",
    `echo x > ${dir}/rules/team.md`,
    `cp ${dir}/workspaces.json /tmp/copy.json`,
    `echo x > ${dir}/workspaces.json.bak`,
    `cd ${dir} && touch notes.txt`,
  ])
    expect(claude("Bash", { command }), command).toBeUndefined();
  expect(claude("Read", { file_path: path.join(dir, "workspaces.json") })).toBeUndefined();
  expect(claude("Write", { file_path: path.join(dir, "rules", "team.md") })).toBeUndefined();
  expect(claude("Write", { file_path: path.join(root, "workspaces.json") })).toBeUndefined();
});

test("G Codex apply_patch and Cursor Write or shell, W they target workspaces.json, T both deny", () => {
  const file = path.join(home, ".config", "workit", "workspaces.json");
  const codex = dispatchHook(
    codexAdapter,
    fixture("codex", "pre-tool-use-apply-patch", root, {
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-{}\n+{"x":1}\n*** End Patch\n`,
      },
    }),
  ).json as { hookSpecificOutput?: Out };
  expectDeny(codex.hookSpecificOutput, "codex apply_patch");
  const cursor = (name: string, overrides: Record<string, unknown>) =>
    dispatchHook(cursorAdapter, fixture("cursor", name, root, overrides)).json as {
      permission?: string;
      agent_message?: string;
    };
  for (const out of [
    cursor("pre-tool-use", { tool_input: { file_path: file } }),
    cursor("before-shell-execution", { command: `echo '{}' > ${file}` }),
  ]) {
    expect(out.permission).toBe("deny");
    expect(out.agent_message).toContain("workit grant set <ws>");
  }
  expect(cursor("before-shell-execution", { command: `cat ${file}` }).permission).not.toBe("deny");
});

test("G OpenCode and Pi, W edits and shell writes hit workspaces.json, T both deny; a read is allowed", () => {
  const file = path.join(home, ".config", "workit", "workspaces.json");
  const opencode = (action: string, resources: string[]) => {
    const event = { action, resources, effect: "allow", message: undefined as string | undefined };
    evaluateShellPermission(root, event);
    return event;
  };
  expect(opencode("edit", [file]).effect).toBe("deny");
  expect(opencode("shell", [`echo f > ${file}`]).effect).toBe("deny");
  expect(opencode("shell", [`cat ${file}`]).effect).toBe("allow");
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  expect(
    enforceToolPolicy({ toolName: "write", input: { path: file } } as never, ctx),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("workit grant set <ws>"),
  });
  expect(
    enforceToolPolicy(
      { toolName: "bash", input: { command: `sed -i s/a/b/ ${file}` } } as never,
      ctx,
    ),
  ).toMatchObject({ block: true });
  expect(
    enforceToolPolicy({ toolName: "bash", input: { command: `cat ${file}` } } as never, ctx),
  ).toBeUndefined();
});

test("G Windows and macOS shapes, W matched on any OS, T case, separators and drive forms do not hide the file", () => {
  const dir = "C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit";
  const real = (file: string) => file.replace("RUNNER~1", "runneradmin");
  const hit = (target: string) => underConfig(dir, "C:\\work", target, "win32", real);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\workspaces.json")).toBe(true);
  expect(hit("c:/users/runneradmin/appdata/roaming/WORKIT/Workspaces.JSON")).toBe(true);
  expect(hit("/c/Users/RUNNER~1/AppData/Roaming/workit/workspaces.json")).toBe(true);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\youtrack.json")).toBe(false);
  expect(
    underConfig("/u/.config/workit", "/w", "/u/.config/workit/Workspaces.json", "darwin"),
  ).toBe(true);
  expect(underConfig("/u/.config/workit", "/w", "/u/.config/workit/Workspaces.json", "linux")).toBe(
    false,
  );
  expect(underConfig("/u/.config/workit", "/w", "/u/.config/workit", "linux")).toBe(true);
});
