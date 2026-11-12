// `workit uninstall --hosts` safety (#832 review): host lists merge, an agent
// is refused before any plan output, an unreadable file stops its host before
// anything changes, a failure lists what was and was not removed, a changed
// Workit-owned file is kept, and a user file keeps its own formatting.
// Every run uses a temp home passed through io.env.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import { run as uninstall } from "@/packages/workit-cli/src/verbs/uninstall";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-uninstall-safety-"));
afterAll(() => {
  // A test may leave a file mode 000; make everything removable first.
  try {
    chmodSync(path.join(scratch, "unreadable", ".cursor", "cli-config.json"), 0o600);
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const io = (home: string, env: NodeJS.ProcessEnv = {}, json = false) => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    json,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, ...env },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  };
  return {
    io: value,
    out: () => out.join(""),
    err: () => err.join(""),
    all: () => out.join("") + err.join(""),
  };
};

const lastJson = (text: string) => JSON.parse(text.trim().split("\n").at(-1) ?? "");

test("D4: Given --hosts twice and a duplicate, Then the hosts merge in first-given order without duplicates", async () => {
  const home = path.join(scratch, "merge");
  mkdirSync(home, { recursive: true });
  const run = io(home, { CLAUDECODE: "1" }, true);
  expect(await uninstall(["--hosts=cursor,cursor", "--hosts=pi,cursor", "--yes"], run.io)).toBe(3);
  expect(lastJson(run.out()).unblock).toBe("workit uninstall --hosts=cursor,pi --yes");
  const preview = io(home, {}, true);
  expect(await uninstall(["--hosts=cursor", "--hosts", "pi", "--preview"], preview.io)).toBe(0);
  expect(lastJson(preview.out()).data.hosts).toEqual(["cursor", "pi"]);
});

/** Cursor with Workit's plugin dir, settings, MCP entry and (via setup) permission block. */
async function cursorHome(name: string, codex = false): Promise<string> {
  const home = path.join(scratch, name);
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  if (codex) mkdirSync(path.join(home, ".codex"), { recursive: true });
  const hosts = codex ? "cursor,codex" : "cursor";
  expect(await setup([`--hosts=${hosts}`, "--no-shell", "--yes"], io(home).io)).toBe(0);
  write(path.join(home, ".cursor/plugins/local/workit/plugin.json"), "{}\n");
  write(
    path.join(home, ".cursor/settings.json"),
    `${JSON.stringify({ enabled_plugins: { workit: true, mine: true } }, null, 2)}\n`,
  );
  write(
    path.join(home, ".cursor/mcp.json"),
    `${JSON.stringify({ mcpServers: { workit: { command: "w" }, mine: { command: "m" } } }, null, 2)}\n`,
  );
  return home;
}

test("D3: Given an agent session and Cursor installed, When --yes or a bare --hosts runs, Then one refusal line is all it prints", async () => {
  const home = await cursorHome("agent-first");
  for (const argv of [["--hosts=cursor", "--yes"], ["--hosts=cursor"]]) {
    const text = io(home, { CLAUDECODE: "1" });
    expect(await uninstall(argv, text.io)).toBe(3);
    expect(text.all().trim().split("\n")).toEqual([
      "workit: an agent cannot run this (CLAUDECODE is set): hand the user `workit uninstall --hosts=cursor --yes` to run in their own terminal",
    ]);
    const json = io(home, { CLAUDECODE: "1" }, true);
    expect(await uninstall(argv, json.io)).toBe(3);
    expect(json.err()).toBe("");
    expect(json.out().trim().split("\n")).toHaveLength(1);
    expect(lastJson(json.out()).data).toEqual({});
  }
  expect(existsSync(path.join(home, ".cursor/plugins/local/workit"))).toBe(true);
});

test("D1: Given an unreadable or invalid host file, When the plan is shown, Then each is a row naming the file and the reason, never its content", async () => {
  const home = await cursorHome("unreadable");
  const cliConfig = path.join(home, ".cursor/cli-config.json");
  chmodSync(cliConfig, 0o000);
  write(path.join(home, ".cursor/mcp.json"), '{"mcpServers": {"workit": SECRET\n');
  write(path.join(home, ".claude/settings.json"), "not json SECRET\n");
  const run = io(home, {}, true);
  expect(await uninstall(["--hosts=cursor,claude-code", "--preview"], run.io)).toBe(0);
  const rows = lastJson(run.out()).data.actions as { host: string; kind: string; path: string }[];
  const unreadable = rows.filter((row) => row.kind === "unreadable");
  expect(unreadable.map((row) => [row.host, row.path])).toEqual([
    ["cursor", path.join(home, ".cursor/mcp.json")],
    ["cursor", cliConfig],
    ["claude-code", path.join(home, ".claude/settings.json")],
  ]);
  expect(rows.some((row) => row.kind === "edit-json-remove" && row.path.endsWith("mcp.json"))).toBe(
    false,
  );
  expect(run.all()).not.toContain("SECRET");
  const text = io(home);
  expect(await uninstall(["--hosts=cursor", "--preview"], text.io)).toBe(0);
  expect(text.all()).toContain(`unreadable ${cliConfig}`);
  expect(text.all()).toContain("is not readable");
  chmodSync(cliConfig, 0o600);
});

/** Every file under `dir` with its bytes. */
const snapshot = (dir: string, files = new Map<string, string>()): Map<string, string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) snapshot(file, files);
    else files.set(file, readFileSync(file, "utf8"));
  }
  return files;
};

test("D2a: Given Cursor with an invalid mcp.json and a clean Codex, When --yes runs for both, Then Cursor is left byte-identical and named, Codex is removed, and it exits non-zero with the command to run again", async () => {
  const home = await cursorHome("partial", true);
  write(path.join(home, ".cursor/mcp.json"), "{ broken\n");
  const cursorBefore = snapshot(path.join(home, ".cursor"));
  const run = io(home);
  expect(await uninstall(["--hosts=cursor,codex", "--yes"], run.io)).toBe(1);
  expect(snapshot(path.join(home, ".cursor"))).toEqual(cursorBefore);
  expect(existsSync(path.join(home, ".codex/rules/workit.rules"))).toBe(false);
  const text = run.all();
  expect(text).toContain("cursor left untouched");
  expect(text).toContain(path.join(home, ".cursor/mcp.json"));
  expect(text).toContain(`removed ${path.join(home, ".codex/rules/workit.rules")}`);
  expect(text).toContain("workit uninstall --hosts=cursor,codex --yes");
  const json = io(home, {}, true);
  expect(await uninstall(["--hosts=cursor", "--yes"], json.io)).toBe(1);
  const envelope = lastJson(json.out());
  expect(envelope.data.skipped).toEqual(["cursor"]);
  expect(envelope.unblock).toContain("workit uninstall --hosts=cursor --yes");
  expect(snapshot(path.join(home, ".cursor"))).toEqual(cursorBefore);
});

test("D2b: Given a host command that fails, When --yes runs, Then it ran first, nothing after it ran, and the output lists what was and was not removed", async () => {
  if (process.platform === "win32") return; // the fake host is a POSIX shell script
  const home = path.join(scratch, "host-fails");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  expect(await setup(["--hosts=claude-code", "--no-shell", "--yes"], io(home).io)).toBe(0);
  const plugin = path.join(home, ".claude/plugins/cache/workit/workit/1.0.0");
  write(
    path.join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "workit", repository: "https://github.com/BrainerVirus/workit" }),
  );
  write(
    path.join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "workit@workit": [{ installPath: plugin, version: "1.0.0", scope: "user" }] },
    }),
  );
  const bin = path.join(home, "bin");
  write(path.join(bin, "claude"), "#!/bin/sh\necho 'claude: plugin store locked' >&2\nexit 7\n");
  chmodSync(path.join(bin, "claude"), 0o755);
  const settings = path.join(home, ".claude/settings.json");
  const before = readFileSync(settings, "utf8");
  const run = io(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  expect(await uninstall(["--hosts=claude-code", "--yes"], run.io)).toBe(1);
  expect(readFileSync(settings, "utf8")).toBe(before);
  const text = run.all();
  expect(text).toContain("failed");
  expect(text).toContain("claude: plugin store locked");
  expect(text).toContain(`not-run ${settings}`);
  expect(text).toContain("workit uninstall --hosts=claude-code --yes");
});

test("O1: Given Workit's Codex rules file with a line the user added, When uninstall runs, Then the preview says it changed and --yes keeps it with the manual step", async () => {
  const home = path.join(scratch, "codex-changed");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  expect(await setup(["--hosts=codex", "--no-shell", "--yes"], io(home).io)).toBe(0);
  const rules = path.join(home, ".codex/rules/workit.rules");
  writeFileSync(rules, `${readFileSync(rules, "utf8")}# my own rule\n`);
  const changed = readFileSync(rules, "utf8");
  const preview = io(home);
  expect(await uninstall(["--hosts=codex", "--preview"], preview.io)).toBe(0);
  expect(preview.all()).toContain("changed since Workit wrote it");
  const run = io(home);
  expect(await uninstall(["--hosts=codex", "--yes"], run.io)).toBe(0);
  expect(readFileSync(rules, "utf8")).toBe(changed);
  expect(run.all()).toContain(`skipped ${rules} (${rules} changed since Workit wrote it`);
});

test("O1: Given Workit's Codex rules file unchanged, When --yes runs, Then it is deleted", async () => {
  const home = path.join(scratch, "codex-unchanged");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  expect(await setup(["--hosts=codex", "--no-shell", "--yes"], io(home).io)).toBe(0);
  expect(await uninstall(["--hosts=codex", "--yes"], io(home).io)).toBe(0);
  expect(existsSync(path.join(home, ".codex/rules/workit.rules"))).toBe(false);
});

test("O2: Given Workit's permission block on Cursor, When the plan is shown, Then the ownership record it changes is a row, and --yes forgets only Cursor's entry", async () => {
  const home = await cursorHome("ownership", true);
  const preview = io(home, {}, true);
  expect(await uninstall(["--hosts=cursor", "--preview"], preview.io)).toBe(0);
  const rows = lastJson(preview.out()).data.actions as {
    host: string;
    kind: string;
    path: string;
  }[];
  const record = rows.find((row) => row.kind === "forget-ownership");
  expect(record?.host).toBe("cursor");
  expect(path.basename(record?.path ?? "")).toBe("host-permissions.json");
  const before = JSON.parse(readFileSync(record?.path ?? "", "utf8"));
  expect(Object.keys(before.hosts).toSorted()).toEqual(["codex", "cursor"]);
  expect(await uninstall(["--hosts=cursor", "--yes"], io(home).io)).toBe(0);
  const after = JSON.parse(readFileSync(record?.path ?? "", "utf8"));
  expect(Object.keys(after.hosts)).toEqual(["codex"]);
});
