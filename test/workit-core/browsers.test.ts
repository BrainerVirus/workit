// #328 automation browsers (wave 9 decider ruling 5): which Chrome counts as
// an automation browser, who owns it, and that reapOrphans and stopProcesses
// stop it under the registry's rules. The process table is a fake behind the
// browserDeps and procTree seams, so no real browser is read or signalled;
// the one real test starts its own dummy launcher and child.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  automationSignature,
  browserDeps,
  parsePsTable,
  parseWin32Table,
  scanBrowsers,
  splitPosixCommand,
  splitWindowsCommand,
  type ProcessEntry,
} from "@/packages/workit-core/src/core/browsers";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { openProcs, reapOrphans, stopProcesses } from "@/packages/workit-core/src/core/procs";
import { stateDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { readProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";

const savedTree = { ...procTree };
const savedBrowsers = { ...browserDeps };
const dirs: string[] = [];

afterEach(() => {
  Object.assign(procTree, savedTree);
  Object.assign(browserDeps, savedBrowsers);
  table.clear();
  sent.length = 0;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// the fake process table

type FakeProc = {
  ppid: number;
  pgid: number;
  start: string;
  alive: boolean;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};
const table = new Map<number, FakeProc>();
const sent: Array<[number, string | number]> = [];
let nextPid = 50_000;

const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

const HOME = "/home/u";

const fake = (platform: string = "linux") => {
  procTree.platform = platform as NodeJS.Platform;
  procTree.start = (pid) => (table.get(pid)?.alive ? table.get(pid)!.start : null);
  procTree.kill = (target, signal) => {
    const members =
      target < 0
        ? [...table.values()].filter((proc) => proc.pgid === -target && proc.alive)
        : [table.get(target)].filter((proc): proc is FakeProc => proc?.alive === true);
    if (members.length === 0) throw esrch();
    if (signal === 0) return;
    sent.push([target, signal]);
    for (const proc of members) proc.alive = false;
  };
  procTree.sleep = async () => {};
  browserDeps.platform = platform;
  browserDeps.home = () => HOME;
  browserDeps.tempDirs = () => ["/tmp"];
  browserDeps.hostname = () => "test-machine";
  browserDeps.processes = () =>
    [...table.entries()]
      .filter(([, proc]) => proc.alive)
      .map(([pid, proc]) => ({
        pid,
        ppid: proc.ppid,
        pgid: proc.pgid,
        command: proc.argv.join(" "),
        argv: proc.argv,
      }));
  browserDeps.argv = () => null;
  browserDeps.environ = (pid) => table.get(pid)?.env ?? null;
  browserDeps.cwd = (pid) => table.get(pid)?.cwd ?? null;
};

/** A running fake process; it leads its own group unless `pgid` says otherwise. */
const proc = (argv: string[], fields: Partial<FakeProc> = {}) => {
  const pid = (nextPid += 1);
  table.set(pid, { ppid: 1, pgid: pid, start: `start-${pid}`, alive: true, argv, ...fields });
  return pid;
};

const alive = (pid: number) => table.get(pid)?.alive === true;

// Real argv shapes: agent-browser 0.27 (a temp profile, port 0), chrome-devtools-mcp (pipe,
// ~/.cache/chrome-devtools-mcp/chrome-profile), Playwright (pipe, a temp profile).
const AGENT_BROWSER = [
  `${HOME}/.agent-browser/browsers/chrome-151.0.7922.77/chrome`,
  "--remote-debugging-port=0",
  "--user-data-dir=/tmp/agent-browser-chrome-k3x9",
  "--no-first-run",
];
const DEVTOOLS_MCP = [
  "/opt/google/chrome/chrome",
  "--remote-debugging-pipe",
  `--user-data-dir=${HOME}/.cache/chrome-devtools-mcp/chrome-profile`,
];
const PLAYWRIGHT = [
  `${HOME}/.cache/ms-playwright/chromium-1200/chrome-linux/chrome`,
  "--remote-debugging-pipe",
  "--user-data-dir=/tmp/playwright_chromiumdev_profile-AbC",
];
const USER_CHROME = ["/opt/google/chrome/chrome", "--restore-last-session"];
const USER_DEBUG_DEFAULT = [
  "/opt/google/chrome/chrome",
  "--remote-debugging-port=9222",
  `--user-data-dir=${HOME}/.config/google-chrome`,
];
const TOOL_CHROME_DEFAULT = [
  `${HOME}/.agent-browser/browsers/chrome-151.0.7922.77/chrome`,
  "--remote-debugging-port=9222",
  `--user-data-dir=${HOME}/.config/google-chrome`,
];

const world = () => {
  const repo = temp("wk-browsers-");
  spawnSync("git", ["init", "-q", "-b", "feature/browsers"], { cwd: repo });
  const env: NodeJS.ProcessEnv = { ...process.env, WORKIT_STATE_DIR: temp("wk-browsers-state-") };
  return { repo, env };
};

/** A live-session marker saying `session` runs in host process `pid`. */
const marker = (
  env: NodeJS.ProcessEnv,
  session: string,
  pid: number | null,
  checkout: string,
  fields: Record<string, unknown> = {},
) => {
  const dir = path.join(stateDir(env), "live-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${session.replaceAll(":", "-")}.json`),
    JSON.stringify({
      version: 1,
      session,
      leads: [session],
      host: "claude-code",
      pid,
      pidStart: pid === null ? null : (table.get(pid)?.start ?? null),
      machine: "test-machine",
      checkout,
      heartbeatAt: new Date().toISOString(),
      ...fields,
    }),
  );
};

const context = (env: NodeJS.ProcessEnv, caller: string | null) => ({
  env,
  actor: { host: "claude-code", session: caller, agentId: null },
  caller,
  graceMs: 100,
});

const browserRows = (env: NodeJS.ProcessEnv): ProcRow[] => {
  const store = openProcs(env);
  try {
    return store.db
      .all("SELECT id FROM procs WHERE kind = 'browser' ORDER BY started_at, id")
      .flatMap((row) => readProc(store, String(row.id)) ?? []);
  } finally {
    store.close();
  }
};

// ---------------------------------------------------------------------------
// what counts as an automation browser

describe("the signature", () => {
  test("Given the argv agent-browser, chrome-devtools-mcp and Playwright launch, Then each is an automation browser", () => {
    fake();
    expect(automationSignature(AGENT_BROWSER)).toEqual({
      userDataDir: "/tmp/agent-browser-chrome-k3x9",
      port: null,
    });
    expect(automationSignature(DEVTOOLS_MCP)?.userDataDir).toBe(
      `${HOME}/.cache/chrome-devtools-mcp/chrome-profile`,
    );
    expect(automationSignature(PLAYWRIGHT)?.userDataDir).toBe(
      "/tmp/playwright_chromiumdev_profile-AbC",
    );
    expect(
      automationSignature([
        "/usr/bin/chromium",
        "--remote-debugging-port=9333",
        "--user-data-dir=/tmp/x",
      ])?.port,
    ).toBe(9333);
  });

  test("Given a browser without the debugging flags, on the user's default profile, with no or an own profile dir, a child process or no browser at all, Then none is one", () => {
    fake();
    for (const argv of [
      USER_CHROME,
      USER_DEBUG_DEFAULT,
      TOOL_CHROME_DEFAULT,
      ["/opt/google/chrome/chrome", "--remote-debugging-port=9222"],
      ["/opt/google/chrome/chrome", "--remote-debugging-port=9222", `--user-data-dir=${HOME}/dbg`],
      [
        "/opt/google/chrome/chrome",
        "--type=renderer",
        "--remote-debugging-port=0",
        "--user-data-dir=/tmp/x",
      ],
      ["/usr/bin/node", "--remote-debugging-port=0", "--user-data-dir=/tmp/x"],
      ["/snap/chromium/3583/usr/lib/chromium-browser/chrome", "--profile-directory=Default"],
    ])
      expect(automationSignature(argv)).toBeNull();
  });

  test("Given a macOS ps line and a Windows command line, Then the executable and flags are split right", () => {
    expect(
      splitPosixCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=/var/folders/ab/T/playwright_chromiumdev_profile-1 about:blank",
      ),
    ).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "--remote-debugging-pipe",
      "--user-data-dir=/var/folders/ab/T/playwright_chromiumdev_profile-1 about:blank",
    ]);
    expect(
      splitWindowsCommand(
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=0 --user-data-dir="C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data"',
      ),
    ).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "--remote-debugging-port=0",
      "--user-data-dir=C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data",
    ]);
    expect(parsePsTable("  101     1   101 /usr/bin/chrome --a\n  bad line\n")).toEqual([
      { pid: 101, ppid: 1, pgid: 101, command: "/usr/bin/chrome --a" },
    ]);
    expect(parseWin32Table('{"p":4,"q":0,"c":null}')).toEqual([
      { pid: 4, ppid: 0, pgid: null, command: "" },
    ]);
    expect(parseWin32Table("not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the registry

describe("reaping and stopping", () => {
  test("Given an automation Chrome naming a dead session, beside the user's own Chromes, When reapOrphans runs, Then only it is stopped and recorded", async () => {
    fake();
    const { repo, env } = world();
    const deadHost = proc(["claude"]);
    marker(env, "s-gone", deadHost, repo);
    table.get(deadHost)!.alive = false;
    const daemon = proc(["agent-browser"]);
    // agent-browser's Chrome after its launcher was reparented: no ancestor reaches a host.
    const chrome = proc(AGENT_BROWSER, {
      pgid: daemon,
      env: { WORKIT_SESSION_ID: "s-gone", WORKIT_HOST: "claude-code" },
    });
    const userChrome = proc(USER_CHROME, { ppid: deadHost });
    const userDebug = proc(USER_DEBUG_DEFAULT, { ppid: deadHost });
    const toolDefault = proc(TOOL_CHROME_DEFAULT, { env: { WORKIT_SESSION_ID: "s-gone" } });

    const report = await reapOrphans(context(env, null));
    expect(report.stopped.map((entry) => entry.cmd)).toEqual([AGENT_BROWSER.join(" ")]);
    expect(report.orphans[0].reason).toBe(`its owner's host process ${deadHost} is gone`);
    // Not a group leader: only the browser itself is signalled, never its launcher's group.
    expect(sent).toEqual([[chrome, "SIGTERM"]]);
    expect(alive(daemon)).toBe(true);
    for (const pid of [userChrome, userDebug, toolDefault]) {
      expect(alive(pid)).toBe(true);
      expect(JSON.stringify(report)).not.toContain(`pid:${pid}`);
    }
    const rows = browserRows(env);
    expect(rows.map((row) => row.pid)).toEqual([chrome]);
    expect(rows[0].session).toBe("s-gone");
    expect(rows[0].endReason).toContain("orphan");
    const ledger = readLedger(repo);
    if (!ledger.ok) throw new Error(ledger.error);
    expect(
      ledger.value.rows.filter(
        (entry) =>
          entry.type === "proc.stopped" &&
          (entry as unknown as { kind: string }).kind === "browser",
      ),
    ).toHaveLength(1);
  });

  test("Given an MCP's Chrome under a live host, When its host later dies, Then the ownership recorded while it lived makes it an orphan", async () => {
    fake();
    const { repo, env } = world();
    const host = proc(["claude"]);
    marker(env, "s-mcp", host, repo);
    const mcp = proc(["node", "chrome-devtools-mcp"], { ppid: host });
    const chrome = proc(DEVTOOLS_MCP, { ppid: mcp });

    const first = await reapOrphans(context(env, null));
    expect(first.stopped).toEqual([]);
    expect(first.unknown).toEqual([]);
    expect(browserRows(env).map((row) => [row.pid, row.session])).toEqual([[chrome, "s-mcp"]]);

    table.get(host)!.alive = false;
    table.get(mcp)!.alive = false;
    table.get(chrome)!.ppid = 1;
    const second = await reapOrphans(context(env, null));
    expect(second.stopped.map((entry) => entry.outcome)).toEqual(["stopped"]);
    // It leads its own group (Puppeteer launches it detached): the group is signalled.
    expect(sent).toEqual([[-chrome, "SIGTERM"]]);
    expect(browserRows(env)).toHaveLength(1);
  });

  test("Given an automation Chrome whose owner is alive, Then neither reapOrphans nor another session stops it; its own session's stopProcesses does", async () => {
    fake();
    const { repo, env } = world();
    const host = proc(["claude"]);
    marker(env, "s-a", host, repo);
    const chrome = proc(PLAYWRIGHT, {
      ppid: 1,
      env: { WORKIT_SESSION_ID: "s-a", WORKIT_HOST: "claude-code" },
      cwd: path.join(repo, "web"),
    });

    expect((await reapOrphans(context(env, null))).stopped).toEqual([]);
    const other = await stopProcesses({ session: "s-a" }, "session-end", context(env, "s-b"));
    expect(other.stopped).toEqual([]);
    expect(other.skipped[0].reason).toContain("owned by session s-a");
    expect(
      (await stopProcesses({ session: "s-b" }, "session-end", context(env, "s-b"))).stopped,
    ).toEqual([]);
    expect(alive(chrome)).toBe(true);

    const own = await stopProcesses({ session: "s-a" }, "session-end", context(env, "s-a"));
    expect(own.stopped.map((entry) => [entry.cwd, entry.outcome])).toEqual([
      [path.join(repo, "web"), "stopped"],
    ]);
    expect(alive(chrome)).toBe(false);
    // One row, though three calls scanned it.
    expect(browserRows(env)).toHaveLength(1);
  });

  test("Given automation Chromes no session is proved to own (no env, no host ancestor, an ancestor that only reuses a host's pid), Then each is reported and never registered or signalled", async () => {
    fake();
    const { repo, env } = world();
    const host = proc(["claude"]);
    marker(env, "s-a", host, repo);
    const chrome = proc(AGENT_BROWSER, { ppid: 1 });
    const reused = proc(["bash"]);
    marker(env, "s-old", reused, repo, { pidStart: "an-older-process" });
    const underReused = proc(PLAYWRIGHT, { ppid: reused });
    const report = await reapOrphans(context(env, null));
    expect(report.unknown).toEqual(
      [chrome, underReused].map((pid, index) => ({
        id: `pid:${pid}`,
        cmd: [AGENT_BROWSER, PLAYWRIGHT][index].join(" "),
        reason: expect.stringContaining("reported, never stopped"),
      })),
    );
    await stopProcesses({ session: "s-a" }, "session-end", context(env, "s-a"));
    expect(sent).toEqual([]);
    expect(browserRows(env)).toEqual([]);
  });

  test("Given an unreadable process table, Then the scan finds nothing and says why, and the reap still runs", async () => {
    fake();
    const { env } = world();
    browserDeps.processes = () => null;
    expect(scanBrowsers(env)).toMatchObject({
      browsers: [],
      error: "the process table could not be read",
    });
    expect((await reapOrphans(context(env, null))).stopped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Windows (fixture)

const WIN_HOME = "C:\\Users\\u";
const win32Table = (entries: Array<{ p: number; q: number; c: string | null }>) =>
  JSON.stringify(entries);

describe("Windows", () => {
  const winFake = (fixture: string) => {
    fake("win32");
    browserDeps.home = () => WIN_HOME;
    browserDeps.tempDirs = () => [`${WIN_HOME}\\AppData\\Local\\Temp`];
    browserDeps.environ = () => null;
    browserDeps.cwd = () => null;
    browserDeps.processes = () =>
      (parseWin32Table(fixture) ?? []).filter((entry: ProcessEntry) => alive(entry.pid));
  };
  const chromeExe = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';

  test("Given Win32_Process rows, Then the same browsers count, and with no host pid to prove an owner each is listed, never stopped", async () => {
    const { env } = world();
    const automation = proc([]);
    const userDefault = proc([]);
    const plain = proc([]);
    winFake(
      win32Table([
        {
          p: automation,
          q: 1,
          c: `${chromeExe} --remote-debugging-port=0 --user-data-dir="${WIN_HOME}\\AppData\\Local\\Temp\\agent-browser-chrome-x"`,
        },
        {
          p: userDefault,
          q: 1,
          c: `${chromeExe} --remote-debugging-port=9222 --user-data-dir="${WIN_HOME}\\AppData\\Local\\Google\\Chrome\\User Data"`,
        },
        { p: plain, q: 1, c: chromeExe },
        { p: 4, q: 0, c: null },
      ]),
    );
    // Windows live-session markers carry no host pid.
    marker(env, "s-win", null, temp("wk-browsers-win-"));
    const report = await reapOrphans(context(env, null));
    expect(report.unknown.map((entry) => entry.id)).toEqual([`pid:${automation}`]);
    expect(report.stopped).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("Given a Windows browser row whose owner is gone, When it is reaped, Then the stop is report-only and nothing is signalled", async () => {
    const { repo, env } = world();
    const host = proc([]);
    const chrome = proc([]);
    winFake(
      win32Table([
        { p: host, q: 1, c: "claude.exe" },
        {
          p: chrome,
          q: host,
          c: `${chromeExe} --remote-debugging-pipe --user-data-dir="${WIN_HOME}\\.cache\\chrome-devtools-mcp\\chrome-profile"`,
        },
      ]),
    );
    marker(env, "s-win", host, repo);
    expect((await reapOrphans(context(env, null))).stopped).toEqual([]);
    table.get(host)!.alive = false;
    const report = await reapOrphans(context(env, null));
    expect(report.orphans).toHaveLength(1);
    expect(report.failed[0].reason).toContain("Windows");
    expect(sent).toEqual([]);
    expect(alive(chrome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// a real launcher and child (ruling 5)

describe.skipIf(process.platform === "win32")("a real launcher and its browser", () => {
  test("Given a launcher whose child looks like an automation Chrome, When the launcher dies, Then the child still matches its session and reapOrphans stops it", async () => {
    const { repo, env } = world();
    const bin = temp("wk-browsers-bin-");
    const fakeChrome = path.join(bin, "chrome");
    symlinkSync("/bin/sh", fakeChrome);
    const profile = path.join(os.tmpdir(), `agent-browser-chrome-wk-${process.pid}`);
    const script = `"${fakeChrome}" -c 'trap "exit 0" TERM; while :; do sleep 0.2; done' chrome --remote-debugging-port=0 --user-data-dir=${profile} & echo $!; wait`;
    const launcher = spawn("sh", ["-c", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, WORKIT_SESSION_ID: "s-real", WORKIT_HOST: "claude-code" },
    });
    const launcherPid = launcher.pid!;
    let output = "";
    launcher.stdout.on("data", (chunk) => (output += String(chunk)));
    const exited = new Promise((resolve) => launcher.on("exit", resolve));
    let child = 0;
    try {
      for (let tries = 0; tries < 100 && !child; tries++) {
        await Bun.sleep(20);
        child = Number.parseInt(output, 10) || 0;
      }
      expect(child).toBeGreaterThan(0);
      // Only this test's two processes are scanned: no real browser is ever read or signalled.
      const mine = new Set([launcherPid, child]);
      const real = savedBrowsers.processes;
      browserDeps.processes = () => (real() ?? []).filter((entry) => mine.has(entry.pid));
      const realAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let tries = 0; tries < 100 && !scanBrowsers(env).browsers.length; tries++)
        await Bun.sleep(20);
      mkdirSync(path.join(stateDir(env), "live-sessions"), { recursive: true });
      writeFileSync(
        path.join(stateDir(env), "live-sessions", "real.json"),
        JSON.stringify({
          version: 1,
          session: "s-real",
          leads: ["s-real"],
          host: "claude-code",
          pid: launcherPid,
          pidStart: procTree.start(launcherPid),
          machine: os.hostname(),
          checkout: repo,
          heartbeatAt: new Date().toISOString(),
        }),
      );

      const whileAlive = await reapOrphans(context(env, null));
      expect(whileAlive.stopped).toEqual([]);
      expect(browserRows(env).map((row) => row.pid)).toEqual([child]);

      process.kill(launcherPid, "SIGKILL");
      await exited;
      expect(realAlive(child)).toBe(true);
      const after = scanBrowsers(env).browsers;
      expect(after.map((browser) => browser.pid)).toEqual([child]);
      // Linux reads the session from the child's own environment; elsewhere the row recorded above holds it.
      if (process.platform === "linux")
        expect(after[0].owner).toMatchObject({ proof: "env", session: "s-real" });

      const reaped = await reapOrphans({ ...context(env, null), graceMs: 3_000 });
      expect(reaped.stopped.map((entry) => entry.outcome)).toEqual(["stopped"]);
      for (let tries = 0; tries < 100 && realAlive(child); tries++) await Bun.sleep(20);
      expect(realAlive(child)).toBe(false);
      expect(browserRows(env)).toHaveLength(1);
    } finally {
      for (const pid of [launcherPid, child])
        if (pid)
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
    }
  }, 20_000);
});
