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
