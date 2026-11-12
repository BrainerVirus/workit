// `workit uninstall --hosts=<h,…> [--preview | --yes]` (#423): removes Workit
// from the named hosts only, after showing the exact files, config keys and
// host commands. Every run uses a temp fixture home passed through io.env, so
// no real host or Workit config dir is read or written.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import { run as uninstall } from "@/packages/workit-cli/src/verbs/uninstall";
import { stateDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-uninstall-hosts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

const io = (home: string, env: NodeJS.ProcessEnv = {}) => {
  const out: string[] = [];
  const value: Io = {
    json: false,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, ...env },
    stdout: (text) => void out.push(text),
    stderr: (text) => void out.push(text),
  };
  return { io: value, text: () => out.join("") };
};

/** Workit on every host, plus the user's own entries next to Workit's. */
async function installedHome(name: string): Promise<string> {
  const home = path.join(scratch, name);
  for (const dir of [".claude", ".codex", ".cursor"])
    mkdirSync(path.join(home, dir), { recursive: true });
  const setupRun = io(home);
  expect(
    await setup(["--hosts=claude-code,codex,cursor", "--no-shell", "--yes"], setupRun.io),
  ).toBe(0);
  for (const file of [
    path.join(home, ".claude/settings.json"),
    path.join(home, ".cursor/cli-config.json"),
  ]) {
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.permissions.allow.push("Shell(my-own-tool)");
    write(file, record);
  }
  const pluginDir = path.join(home, ".cursor/plugins/local/workit");
  write(path.join(pluginDir, "plugin.json"), { name: "workit" });
  write(path.join(home, ".cursor/settings.json"), {
    enabled_plugins: { workit: true, mine: true },
    plugin_dirs: [pluginDir, "/opt/mine"],
  });
  write(path.join(home, ".cursor/mcp.json"), {
    mcpServers: { workit: { command: "workit" }, mine: { command: "mine" } },
  });
  write(path.join(home, ".config/opencode/opencode.json"), {
    plugins: ["@workit-dev/opencode", "other"],
  });
  write(path.join(home, ".codex/plugins/workit/plugin.json"), { name: "workit" });
  write(path.join(home, ".pi/config.json"), { extensions: ["npm:@workit-dev/pi", "npm:mine"] });
  write(path.join(home, ".config/workit/workspaces.json"), { canary: true });
  return home;
}

/** Every file under `dir` with its bytes. */
const snapshot = (dir: string, files = new Map<string, string>()): Map<string, string> => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) snapshot(file, files);
    else files.set(file, readFileSync(file, "utf8"));
  }
  return files;
};

/** The envelope: the last line of output (the plan goes to stderr first). */
const lastJson = (text: string) => JSON.parse(text.trim().split("\n").at(-1) ?? "");

const cursorOwned = (home: string, file: string) =>
  file.startsWith(path.join(home, ".cursor") + path.sep) ||
  file.startsWith(stateDir({ HOME: home }) + path.sep);

test("Given Workit on several hosts, When uninstall --hosts=cursor --preview runs, Then it lists Cursor's files, keys and nothing else, and changes nothing", async () => {
  const home = await installedHome("preview");
  const before = snapshot(home);
  const run = io(home);
  expect(await uninstall(["--hosts=cursor", "--preview"], run.io)).toBe(0);
  const text = run.text();
  for (const file of ["settings.json", "mcp.json", "cli-config.json", "plugins/local/workit"])
    expect(text).toContain(path.join(home, ".cursor", file));
  expect(text).toContain("- enabled_plugins.workit");
  expect(text).toContain(`- plugin_dirs[] "${path.join(home, ".cursor/plugins/local/workit")}"`);
  expect(text).toContain("- mcpServers.workit");
  expect(text).toContain("- permissions.allow[]");
  expect(text).not.toContain("my-own-tool");
  expect(text).not.toContain("mcpServers.mine");
  for (const other of [".claude", ".codex", ".config/opencode", ".pi"])
    expect(text).not.toContain(path.join(home, other));
  expect(text).toContain("is always kept");
  expect(text).toContain("Preview: nothing changed.");
  expect(snapshot(home)).toEqual(before);
});

test("Given Workit on several hosts, When uninstall --hosts=cursor --yes runs, Then only Cursor's Workit files and entries go; other hosts, user rules and the Workit config are byte-identical", async () => {
  const home = await installedHome("apply");
  const before = snapshot(home);
  const run = io(home);
  expect(await uninstall(["--hosts=cursor", "--yes"], run.io)).toBe(0);
  const after = snapshot(home);
  for (const [file, bytes] of before)
    if (!cursorOwned(home, file)) expect([file, after.get(file)]).toEqual([file, bytes]);
  expect(existsSync(path.join(home, ".cursor/plugins/local/workit"))).toBe(false);
  const settings = JSON.parse(after.get(path.join(home, ".cursor/settings.json")) ?? "");
  expect(settings).toEqual({ enabled_plugins: { mine: true }, plugin_dirs: ["/opt/mine"] });
  const mcp = JSON.parse(after.get(path.join(home, ".cursor/mcp.json")) ?? "");
  expect(mcp).toEqual({ mcpServers: { mine: { command: "mine" } } });
  const cli = JSON.parse(after.get(path.join(home, ".cursor/cli-config.json")) ?? "");
  expect(cli.permissions.allow).toEqual(["Shell(my-own-tool)"]);
  expect(run.text()).toContain("Restart the host sessions");
});

test("Given --hosts with an unknown name or no value, Then uninstall is refused naming the valid hosts", async () => {
  const home = await installedHome("refused");
  const before = snapshot(home);
  for (const argv of [["--hosts=cursr", "--yes"], ["--hosts=", "--yes"], ["--hosts"], ["--yes"]]) {
    const run = io(home);
    run.io.json = true;
    expect(await uninstall(argv, run.io)).not.toBe(0);
    const envelope = lastJson(run.text());
    expect(envelope.code).toBe("invalid_input");
    expect(envelope.unblock).toContain("--hosts=claude-code,codex,cursor,opencode,pi");
    if (argv[0] === "--hosts=cursr")
      expect(envelope.error).toBe(
        "unknown host cursr; hosts: claude-code, codex, cursor, opencode, pi",
      );
  }
  expect(snapshot(home)).toEqual(before);
});

test("Given an agent or headless shell, When uninstall --hosts=cursor runs, Then it is refused naming the command the user runs, and nothing changes", async () => {
  const home = await installedHome("agent");
  const before = snapshot(home);
  const agent = io(home, { CLAUDECODE: "1" });
  agent.io.json = true;
  expect(await uninstall(["--hosts=cursor", "--yes"], agent.io)).not.toBe(0);
  const refused = lastJson(agent.text());
  expect(refused.code).toBe("blocked");
  expect(refused.error).toContain("CLAUDECODE is set");
  expect(refused.unblock).toBe("workit uninstall --hosts=cursor --yes");
  // Headless without --yes: test stdin is not a terminal.
  const headless = io(home);
  headless.io.json = true;
  expect(await uninstall(["--hosts=cursor"], headless.io)).not.toBe(0);
  const blocked = lastJson(headless.text());
  expect(blocked.code).toBe("blocked");
  expect(blocked.unblock).toContain("workit uninstall --hosts=cursor --yes");
  expect(snapshot(home)).toEqual(before);
});

test("Given an agent shell and nothing installed, When uninstall --hosts=cursor --yes runs, Then it is still refused, while --preview answers", async () => {
  const home = path.join(scratch, "agent-empty");
  mkdirSync(home, { recursive: true });
  const agent = io(home, { CLAUDECODE: "1" });
  agent.io.json = true;
  expect(await uninstall(["--hosts=cursor", "--yes"], agent.io)).toBe(3);
  expect(lastJson(agent.text()).unblock).toBe("workit uninstall --hosts=cursor --yes");
  const preview = io(home, { CLAUDECODE: "1" });
  expect(await uninstall(["--hosts=cursor", "--preview"], preview.io)).toBe(0);
  expect(preview.text()).toContain("nothing to remove");
});

test("Given no flags and no terminal, When uninstall runs, Then it keeps the interactive form's TTY refusal", async () => {
  const run = io(scratch);
  run.io.json = true;
  expect(await uninstall([], run.io)).not.toBe(0);
  expect(lastJson(run.text()).error).toContain("is interactive");
});
