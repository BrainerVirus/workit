// An agent session cannot raise its own grants or set youtrack.writes by
// writing the config dir's workspaces.json, nor re-seal them by writing its
// workspaces.json.seal (#819): every host whose hooks deny refuses the edit or
// shell write and names the command the user runs.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
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
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import {
  shellGate,
  underConfig,
  unquotedWindowsRegistry,
  writeGate,
} from "@/packages/workit-core/src/hooks/write-gate";
import { evaluateShellPermission } from "@/packages/workit-opencode/src/v2/permissions";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-config-guard-")));
const home = path.join(base, "home");
const root = tempRoot("workit-config-guard-root-");
// APPDATA too: on Windows the default config dir is %APPDATA%\workit, never the runner's own.
const KEYS = [
  "HOME",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "WORKIT_STATE_DIR",
];
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

/**
 * The platform's default config dir under a home with no override, as the
 * resolver builds it: `<home>/.config/workit`, or `<home>\AppData\Roaming\workit`
 * on Windows (APPDATA is unset in these tests).
 */
const DEFAULT = configDir({ HOME: home });
const ACCOUNT = configDir({ HOME: path.join(base, "account") });
/** A path as a POSIX shell on Windows (Git Bash) is given it: forward slashes, no unquoted `\`. */
const sh = (file: string) => file.replaceAll("\\", "/");
/** The default dir relative to the home, for `~` and `$HOME` spellings. */
const fromHome = sh(path.relative(home, DEFAULT));

/** The config dir each form resolves to, made on disk. */
const FORMS: Array<{ name: string; env: Record<string, string>; dir: string }> = [
  { name: "default", env: {}, dir: DEFAULT },
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
    dir: ACCOUNT,
  },
];
for (const form of FORMS) mkdirSync(path.join(form.dir, "rules"), { recursive: true });
/** The files only the user writes: the grants and the seal that vouches for them. */
const FILES = ["workspaces.json", "workspaces.json.seal"];

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

const shellWrites = (native: string, file: string, dir = sh(native)) => [
  `echo '{}' > ${dir}/${file}`,
  `echo '{}' >> ${dir}/${file}`,
  `echo '{}' | tee ${dir}/${file}`,
  `cp /tmp/x.json ${dir}/${file}`,
  `cp /tmp/${file} ${dir}/`,
  `mv /tmp/x.json ${dir}/${file}`,
  `mv ${dir}/${file}.bak ${dir}/${file}`,
  `sed -i 's/false/true/' ${dir}/${file}`,
  `cd ${dir} && echo '{}' > ${file}`,
  `workit check --name x -- bash -c 'echo f > ${dir}/${file}'`,
];

test("G each config dir form, W Claude Code Edit, Write or MultiEdit targets workspaces.json or its seal, T denied naming the user's command", () => {
  for (const form of FORMS) {
    set(form.env);
    for (const file of FILES)
      for (const tool of ["Edit", "Write", "MultiEdit"])
        expectDeny(
          claude(tool, { file_path: path.join(form.dir, file) }),
          `${form.name} ${tool} ${file}`,
        );
  }
});

test("G each config dir form, W a shell writes, copies or moves workspaces.json or its seal, T every one is denied", () => {
  for (const form of FORMS) {
    set(form.env);
    for (const file of FILES)
      for (const command of shellWrites(form.dir, file))
        expectDeny(claude("Bash", { command }), `${form.name}: ${command}`);
  }
});

test("G a hard link to workspaces.json or its seal, W a shell or the Edit tool writes it, or a command makes one, T denied", () => {
  const links = path.join(root, "links");
  mkdirSync(links, { recursive: true });
  for (const file of FILES) {
    const target = path.join(ACCOUNT, file);
    writeFileSync(target, "{}");
    const link = path.join(links, `${file}.link`);
    linkSync(target, link);
    for (const command of [
      `echo '{}' > links/${file}.link`,
      `ln ${sh(target)} links/${file}.2`,
      `cp -l ${sh(target)} links/${file}.3`,
    ])
      expect(shellGate(root, command, null).kind, command).toBe("deny");
    expect(writeGate(root, [link]).kind, `Edit through a hard link to ${file}`).toBe("deny");
    rmSync(target);
  }
  rmSync(links, { recursive: true, force: true });
});

test("G the default dir under ~, W a shell writes through ~, $HOME, a symlink or a .. path, T denied", () => {
  const link = path.join(base, "link");
  // A junction on Windows needs no symlink privilege; the type is ignored elsewhere.
  symlinkSync(DEFAULT, link, "junction");
  for (const command of [
    `echo '{}' > ~/${fromHome}/workspaces.json`,
    `cp /tmp/x $HOME/${fromHome}/workspaces.json`,
    `echo '{}' > ${sh(link)}/workspaces.json`,
    `echo '{}' > ${sh(DEFAULT)}/rules/../workspaces.json`,
  ])
    expectDeny(claude("Bash", { command }), command);
  expectDeny(claude("Write", { file_path: path.join(link, "workspaces.json") }), "symlink Write");
  expectDeny(
    claude("Edit", {
      file_path: [path.dirname(DEFAULT), "x", "..", "workit", "workspaces.json"].join(path.sep),
    }),
    ".. Edit",
  );
});

test("G the config file, W a session reads it, runs grant show or workspace list, or writes a file that grants nothing, T nothing is denied", () => {
  const dir = sh(DEFAULT);
  for (const command of [
    `cat ${dir}/workspaces.json`,
    `grep merge ${dir}/workspaces.json`,
    `jq . ${dir}/workspaces.json > /tmp/out.json`,
    "workit grant show",
    "workit workspace list",
    `echo x > ${dir}/rules/team.md`,
    `cp ${dir}/workspaces.json /tmp/copy.json`,
    `echo x > ${dir}/workspaces.json.bak`,
    `cat ${dir}/workspaces.json.seal`,
    `cp ${dir}/workspaces.json.seal /tmp/seal.json`,
    `cd ${dir} && touch notes.txt`,
  ])
    expect(claude("Bash", { command }), command).toBeUndefined();
  expect(claude("Read", { file_path: path.join(DEFAULT, "workspaces.json") })).toBeUndefined();
  expect(claude("Write", { file_path: path.join(DEFAULT, "rules", "team.md") })).toBeUndefined();
  expect(claude("Write", { file_path: path.join(root, "workspaces.json") })).toBeUndefined();
});

test("G Codex apply_patch and Cursor Write or shell, W they target workspaces.json or its seal, T both deny", () => {
  for (const name of FILES) codexCursor(path.join(DEFAULT, name));
});

const codexCursor = (file: string) => {
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
    cursor("before-shell-execution", { command: `echo '{}' > ${sh(file)}` }),
  ]) {
    expect(out.permission).toBe("deny");
    expect(out.agent_message).toContain("workit grant set <ws>");
  }
  expect(cursor("before-shell-execution", { command: `cat ${sh(file)}` }).permission).not.toBe(
    "deny",
  );
};

test("G OpenCode and Pi, W edits and shell writes hit workspaces.json or its seal, T both deny; a read is allowed", () => {
  for (const name of FILES) openCodePi(path.join(DEFAULT, name));
});

const openCodePi = (file: string) => {
  const opencode = (action: string, resources: string[]) => {
    const event = { action, resources, effect: "allow", message: undefined as string | undefined };
    evaluateShellPermission(root, event);
    return event;
  };
  expect(opencode("edit", [file]).effect).toBe("deny");
  expect(opencode("shell", [`echo f > ${sh(file)}`]).effect).toBe("deny");
  expect(opencode("shell", [`cat ${sh(file)}`]).effect).toBe("allow");
  const ctx = { cwd: root, isProjectTrusted: () => true } as never;
  expect(
    enforceToolPolicy({ toolName: "write", input: { path: file } } as never, ctx),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("workit grant set <ws>"),
  });
  expect(
    enforceToolPolicy(
      { toolName: "bash", input: { command: `sed -i s/a/b/ ${sh(file)}` } } as never,
      ctx,
    ),
  ).toMatchObject({ block: true });
  expect(
    enforceToolPolicy({ toolName: "bash", input: { command: `cat ${sh(file)}` } } as never, ctx),
  ).toBeUndefined();
};

test("G Windows and macOS shapes, W matched on any OS, T case, separators and drive forms do not hide the file", () => {
  const dir = "C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit";
  const real = (file: string) => file.replace("RUNNER~1", "runneradmin");
  const hit = (target: string) => underConfig(dir, "C:\\work", target, "win32", real);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\workspaces.json")).toBe(true);
  expect(hit("c:/users/runneradmin/appdata/roaming/WORKIT/Workspaces.JSON")).toBe(true);
  expect(hit("/c/Users/RUNNER~1/AppData/Roaming/workit/workspaces.json")).toBe(true);
  expect(hit("c:/users/runneradmin/appdata/roaming/workit/Workspaces.json.SEAL")).toBe(true);
  expect(hit("C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\youtrack.json")).toBe(false);
  // The default dir the resolver builds for a Windows home with no APPDATA (mixed separators here).
  const fallback = configDir({ HOME: "C:\\Users\\RUNNER~1" }, "win32");
  const file = "C:\\Users\\runneradmin\\AppData\\Roaming\\workit\\workspaces.json";
  expect(underConfig(fallback, "C:\\work", file, "win32", real)).toBe(true);
  expect(
    underConfig(
      fallback,
      "C:\\work",
      "C:\\Users\\RUNNER~1\\.config\\workit\\workspaces.json",
      "win32",
      real,
    ),
  ).toBe(false);
  expect(
    underConfig("/u/.config/workit", "/w", "/u/.config/workit/Workspaces.json", "darwin"),
  ).toBe(true);
  expect(underConfig("/u/.config/workit", "/w", "/u/.config/workit/Workspaces.json", "linux")).toBe(
    false,
  );
  expect(underConfig("/u/.config/workit", "/w", "/u/.config/workit", "linux")).toBe(true);
});

test("G a Windows config dir, W a POSIX shell drops the unquoted backslashes of a write to its workspaces.json, T the text check still names the config guard", () => {
  set({ WORKIT_CONFIG: "C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit" });
  const file = "C:\\Users\\RUNNER~1\\AppData\\Roaming\\workit\\workspaces.json";
  expect(unquotedWindowsRegistry(`echo '{}' > ${file}`, "win32")).toBe("grants");
  expect(unquotedWindowsRegistry(`cp x.json ${file.toLowerCase()}`, "win32")).toBe("grants");
  expect(unquotedWindowsRegistry(`mv x ${file}.seal`, "win32")).toBe("grants");
  expect(unquotedWindowsRegistry(`cat ${file}`, "win32")).toBeNull();
  expect(
    unquotedWindowsRegistry(`echo '{}' > ${file.replace("workspaces", "youtrack")}`, "win32"),
  ).toBeNull();
  expect(unquotedWindowsRegistry(`echo '{}' > ${file}`, "linux")).toBeNull();
});
