// `workit uninstall --hosts` safety (#832 review): host lists merge, an agent
// is refused before any plan output, an unreadable file stops its host before
// anything changes, a failure lists what was and was not removed, a changed
// Workit-owned file is kept, a user file keeps its own formatting, and every
// preview row is what `--yes` then reports (a host left with only its entry in
// the permission record still has that row).
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
  expect(text).toContain("then run workit uninstall --hosts=cursor --yes");
  expect(text).not.toContain("--hosts=cursor,codex --yes");
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
  expect(text).toContain("(claude: plugin store locked)");
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
  expect(preview.all()).toContain(`${rules} differs from what this Workit version writes`);
  const run = io(home);
  expect(await uninstall(["--hosts=codex", "--yes"], run.io)).toBe(0);
  expect(readFileSync(rules, "utf8")).toBe(changed);
  expect(run.all()).toContain(
    `skipped ${rules} (${rules} differs from what this Workit version writes, so it is kept.`,
  );
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

test("O3: Given a compact settings.json and a tab-indented CRLF mcp.json, When --yes removes Workit's keys, Then each keeps its own layout", async () => {
  const home = await cursorHome("layout");
  const settings = path.join(home, ".cursor/settings.json");
  const mcp = path.join(home, ".cursor/mcp.json");
  writeFileSync(settings, '{"enabled_plugins":{"workit":true,"mine":true}}');
  writeFileSync(
    mcp,
    '{\r\n\t"mcpServers": {\r\n\t\t"workit": {"command": "w"},\r\n\t\t"mine": {"command": "m"}\r\n\t}\r\n}\r\n',
  );
  expect(await uninstall(["--hosts=cursor", "--yes"], io(home).io)).toBe(0);
  expect(readFileSync(settings, "utf8")).toBe('{"enabled_plugins":{"mine":true}}');
  expect(readFileSync(mcp, "utf8")).toBe(
    '{\r\n\t"mcpServers": {\r\n\t\t"mine": {\r\n\t\t\t"command": "m"\r\n\t\t}\r\n\t}\r\n}\r\n',
  );
});

type Row = { host: string; kind: string; path: string; detail: string };
type Outcome = { host: string; path: string; status: string; detail?: string };

/** What `--yes` must report for each preview row: its kind's outcome, and why for a row not removed. */
const promised = (rows: Row[]) =>
  rows
    .map((row) =>
      JSON.stringify(
        row.kind === "keep-foreign"
          ? [row.host, row.path, "skipped", row.detail]
          : row.kind === "unreadable"
            ? [row.host, row.path, "failed", row.detail]
            : [row.host, row.path, "removed"],
      ),
    )
    .toSorted();

const reported = (outcomes: Outcome[]) =>
  outcomes
    .map((entry) =>
      JSON.stringify(
        entry.status === "removed"
          ? [entry.host, entry.path, entry.status]
          : [entry.host, entry.path, entry.status, entry.detail],
      ),
    )
    .toSorted();

/** The rows `--preview --json` lists, then the outcomes `--yes --json` reports. */
async function previewThenApply(home: string, host: string, env: NodeJS.ProcessEnv = {}) {
  const preview = io(home, env, true);
  expect(await uninstall([`--hosts=${host}`, "--preview"], preview.io)).toBe(0);
  const run = io(home, env, true);
  const code = await uninstall([`--hosts=${host}`, "--yes"], run.io);
  return {
    code,
    rows: lastJson(preview.out()).data.actions as Row[],
    outcomes: lastJson(run.out()).data.removed as Outcome[],
  };
}

const recordedHosts = (record: string): string[] =>
  Object.keys(JSON.parse(readFileSync(record, "utf8")).hosts);

test("V1: Given a Codex rules file with a line the user added, When --preview then --yes run, Then each preview row is what --yes reports: the file and its record entry are kept", async () => {
  const home = path.join(scratch, "codex-kept");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  expect(await setup(["--hosts=codex", "--no-shell", "--yes"], io(home).io)).toBe(0);
  const rules = path.join(home, ".codex/rules/workit.rules");
  writeFileSync(rules, `${readFileSync(rules, "utf8")}# my own rule\n`);
  const kept = await previewThenApply(home, "codex");
  expect(kept.code).toBe(0);
  expect(kept.rows.map((row) => [row.kind, path.basename(row.path)])).toEqual([
    ["keep-foreign", "workit.rules"],
    ["keep-foreign", "host-permissions.json"],
  ]);
  expect(reported(kept.outcomes)).toEqual(promised(kept.rows));
  // True whether the user edited it or an older Workit wrote it.
  expect(kept.rows[0].detail).toContain("differs from what this Workit version writes");
  expect(kept.rows[0].detail).toContain("`workit upgrade` rewrites it and uninstall then removes");
  expect(kept.rows[0].detail).toContain("if you added rules, move them out and delete it");
  const record = kept.rows[1].path;
  expect(recordedHosts(record)).toEqual(["codex"]);
  // Nothing in this plan is removed, and neither run says otherwise.
  const keptPreview = io(home);
  expect(await uninstall(["--hosts=codex", "--preview"], keptPreview.io)).toBe(0);
  expect(keptPreview.all()).toContain("would remove nothing");
  expect(keptPreview.all()).not.toContain("--yes` removes it");
  const keptRun = io(home);
  expect(await uninstall(["--hosts=codex", "--yes"], keptRun.io)).toBe(0);
  expect(keptRun.all()).toContain("Nothing removed.");
  expect(keptRun.all()).not.toContain("Restart the host sessions");

  // The user deletes the kept file by hand: the record entry is all that is left.
  rmSync(rules);
  const text = io(home);
  expect(await uninstall(["--hosts=codex", "--preview"], text.io)).toBe(0);
  expect(text.all()).not.toContain("not installed");
  expect(text.all()).toContain(`codex forget-ownership ${record}`);
  const cleared = await previewThenApply(home, "codex");
  expect(cleared.code).toBe(0);
  expect(cleared.rows.map((row) => [row.kind, row.path])).toEqual([["forget-ownership", record]]);
  expect(reported(cleared.outcomes)).toEqual(promised(cleared.rows));
  expect(recordedHosts(record)).toEqual([]);
  const after = io(home);
  expect(await uninstall(["--hosts=codex", "--preview"], after.io)).toBe(0);
  expect(after.all()).toContain("Workit is not installed on codex: nothing to remove.");
});

test("V2: Given Claude Code and Cursor whose only trace is the permission record, When each is previewed then removed, Then its record entry is listed and cleared", async () => {
  const home = path.join(scratch, "record-only");
  for (const dir of [".claude", ".cursor"]) mkdirSync(path.join(home, dir), { recursive: true });
  expect(await setup(["--hosts=claude-code,cursor", "--no-shell", "--yes"], io(home).io)).toBe(0);
  // One file deleted by hand, the other cleaned by hand.
  rmSync(path.join(home, ".claude/settings.json"));
  writeFileSync(path.join(home, ".cursor/cli-config.json"), '{"mine":true}\n');
  for (const [host, left] of [
    ["claude-code", ["cursor"]],
    ["cursor", []],
  ] as const) {
    const run = await previewThenApply(home, host);
    expect(run.code).toBe(0);
    expect(run.rows.map((row) => [row.host, row.kind])).toEqual([[host, "forget-ownership"]]);
    expect(reported(run.outcomes)).toEqual(promised(run.rows));
    expect(recordedHosts(run.rows[0].path)).toEqual([...left]);
  }
  expect(readFileSync(path.join(home, ".cursor/cli-config.json"), "utf8")).toBe('{"mine":true}\n');
});

test("V3: Given Cursor with an invalid mcp.json, When --preview then --yes run, Then the plan is that file alone, saying Cursor is left untouched, and --yes reports exactly it", async () => {
  const home = await cursorHome("blocked-rows");
  const mcp = path.join(home, ".cursor/mcp.json");
  write(mcp, "{ broken\n");
  const run = await previewThenApply(home, "cursor");
  expect(run.code).toBe(1);
  expect(run.rows.map((row) => [row.kind, row.path])).toEqual([["unreadable", mcp]]);
  expect(run.rows[0].detail).toContain("cursor is left untouched until then");
  expect(reported(run.outcomes)).toEqual(promised(run.rows));
});

test("P1: Given Workit on all five hosts, When each host is previewed then removed, Then the preview rows are exactly the outcomes --yes reports", async () => {
  if (process.platform === "win32") return; // the fake host is a POSIX shell script
  const home = await cursorHome("every-host", true);
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
  write(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "claude"), 0o755);
  write(path.join(home, ".codex/plugins/workit/plugin.json"), "{}\n");
  write(
    path.join(home, ".config/opencode/opencode.json"),
    `${JSON.stringify({ plugins: ["@workit-dev/opencode", "other"] }, null, 2)}\n`,
  );
  write(
    path.join(home, ".pi/config.json"),
    `${JSON.stringify({ extensions: ["npm:@workit-dev/pi", "npm:mine"] }, null, 2)}\n`,
  );
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const kinds: Record<string, string[]> = {};
  for (const host of ["claude-code", "codex", "cursor", "opencode", "pi"]) {
    const run = await previewThenApply(home, host, env);
    expect(run.code).toBe(0);
    expect(reported(run.outcomes)).toEqual(promised(run.rows));
    kinds[host] = run.rows.map((row) => row.kind);
  }
  expect(kinds).toEqual({
    "claude-code": ["host-command", "edit-json-remove", "forget-ownership"],
    codex: ["remove-dir", "remove-file", "forget-ownership"],
    cursor: [
      "edit-json-remove",
      "edit-json-remove",
      "remove-dir",
      "edit-json-remove",
      "forget-ownership",
    ],
    opencode: ["edit-json-remove"],
    pi: ["edit-json-remove"],
  });
});
