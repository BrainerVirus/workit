import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  UPDATE_TTL_MS,
  agentHostMarker,
  launchUpdateCheck,
  readUpdateCache,
  refreshUpdateCache,
  writeUpdateCache,
  type LaunchContext,
  type LaunchDeps,
  type UpdateCache,
} from "@/packages/workit-cli/src/update-check";
import { runUpgradeCommand } from "@/packages/workit-cli/src/upgrade";
import pkg from "@/packages/workit-cli/package.json" with { type: "json" };

// Every case runs on a temp HOME with injected TTY flags, env, clock, registry
// and upgrade runner: no network, no real ~/.config or Workit state.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 29, 12);
const HOUR = 60 * 60 * 1000;

const setup = (cache?: UpdateCache, config?: Record<string, unknown>) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-update-check-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    WORKFLOW_TOOLKIT_STATE: path.join(home, "state"),
    TERM: "xterm-256color",
    PATH: "/usr/bin",
  };
  if (config) {
    mkdirSync(path.join(home, ".config/workit"), { recursive: true });
    writeFileSync(path.join(home, ".config/workit/config.json"), JSON.stringify(config));
  }
  if (cache) writeUpdateCache(env, cache);
  const calls = {
    ask: [] as string[],
    upgrade: 0,
    reexec: [] as string[][],
    refresh: 0,
  };
  const written: string[] = [];
  let answer = "s";
  let upgradeCode = 0;
  const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
    env,
    stdin: { isTTY: true },
    stderr: { isTTY: true },
    write: (text) => void written.push(stripVTControlCharacters(text)),
    now: () => NOW,
    installed: "1.0.0",
    refresh: () => void (calls.refresh += 1),
    ask: async (question) => {
      calls.ask.push(stripVTControlCharacters(question));
      return answer;
    },
    upgrade: async () => {
      calls.upgrade += 1;
      return upgradeCode;
    },
    reexec: (argv) => {
      calls.reexec.push([...argv]);
      return 7;
    },
    ...over,
  });
  return {
    home,
    env,
    calls,
    written,
    deps,
    answer: (value: string) => void (answer = value),
    upgradeFails: () => void (upgradeCode = 1),
    cacheFile: path.join(home, "state/update-check.json"),
  };
};

const context = (over: Partial<LaunchContext> = {}): LaunchContext => ({
  argv: ["status", "--all"],
  command: "status",
  json: false,
  ...over,
});
const fresh = (over: UpdateCache = {}): UpdateCache => ({
  checkedAt: NOW - HOUR,
  latest: "2.0.0",
  ...over,
});

test("given a non-interactive launch, then nothing is asked, upgraded, refreshed or written", async () => {
  const cases: [string, Partial<LaunchDeps>, Partial<LaunchContext>, NodeJS.ProcessEnv][] = [
    ["stdin not a TTY", { stdin: { isTTY: false } }, {}, {}],
    ["stderr not a TTY", { stderr: { isTTY: false } }, {}, {}],
    ["CI", {}, {}, { CI: "true" }],
    ["--json", {}, { json: true }, {}],
    ["Claude Code", {}, {}, { CLAUDECODE: "1" }],
    ["Codex", {}, {}, { CODEX_THREAD_ID: "t" }],
    ["OpenCode", {}, {}, { OPENCODE_SESSION_ID: "s" }],
    ["Cursor", {}, {}, { CURSOR_AGENT: "1" }],
    ["Pi", {}, {}, { PI_SESSION_ID: "p" }],
    [
      "hook or MCP process (no terminal)",
      { stdin: { isTTY: false }, stderr: { isTTY: false } },
      {},
      {},
    ],
    ["re-executed command", {}, {}, { WORKIT_UPDATE_CHECK: "0" }],
    ["workit upgrade itself", {}, { command: "upgrade", argv: ["upgrade"] }, {}],
    ["workit --version", {}, { command: "--version", argv: ["--version"] }, {}],
  ];
  for (const [name, over, ctx, extraEnv] of cases) {
    // A stale cache with a newer version: an interactive launch would act on it.
    const t = setup({ checkedAt: NOW - 2 * UPDATE_TTL_MS, latest: "2.0.0" });
    const before = readFileSync(t.cacheFile, "utf8");
    const result = await launchUpdateCheck(
      context(ctx),
      t.deps({ ...over, env: { ...t.env, ...extraEnv } }),
    );
    expect(result, name).toBeUndefined();
    expect(t.calls, name).toEqual({
      ask: [],
      upgrade: 0,
      reexec: [],
      refresh: 0,
    });
    expect(t.written, name).toEqual([]);
    expect(readFileSync(t.cacheFile, "utf8"), name).toBe(before);
  }
});

test("given only a profile variable such as CODEX_HOME, then the launch still counts as human", () => {
  expect(agentHostMarker({ CODEX_HOME: "/x", PI_CODING_AGENT_DIR: "/y" })).toBeUndefined();
  expect(agentHostMarker({ CODEX_HOME: "/x", CODEX_SANDBOX: "seatbelt" })).toBe("CODEX_SANDBOX");
});

test("given a newer cached version, when the answer is u, then it upgrades and re-runs the original argv", async () => {
  const t = setup(fresh());
  t.answer("u");
  expect(await launchUpdateCheck(context(), t.deps())).toBe(7);
  expect(t.calls.ask).toHaveLength(1);
  expect(t.calls.ask[0]).toContain("1.0.0 -> 2.0.0");
  expect(t.calls.ask[0]).toContain("[u]pgrade now / [s]kip for now / [n]ever for this version");
  expect(t.calls.upgrade).toBe(1);
  expect(t.calls.reexec).toEqual([["status", "--all"]]);
});

test("given s, then the prompt stays quiet inside the 24 h window and asks again after it", async () => {
  const t = setup(fresh());
  t.answer("s");
  expect(await launchUpdateCheck(context(), t.deps())).toBeUndefined();
  expect(t.calls.upgrade).toBe(0);
  expect(readUpdateCache(t.env).snoozedAt).toBe(NOW);
  await launchUpdateCheck(context(), t.deps({ now: () => NOW + 23 * HOUR }));
  expect(t.calls.ask).toHaveLength(1);
  await launchUpdateCheck(context(), t.deps({ now: () => NOW + 25 * HOUR }));
  expect(t.calls.ask).toHaveLength(2);
});

test("given n, then that version is never offered again, but a newer one is", async () => {
  const t = setup(fresh());
  t.answer("n");
  await launchUpdateCheck(context(), t.deps());
  expect(readUpdateCache(t.env).skipped).toBe("2.0.0");
  await launchUpdateCheck(context(), t.deps({ now: () => NOW + 30 * 24 * HOUR }));
  expect(t.calls.ask).toHaveLength(1);
  writeUpdateCache(t.env, { ...readUpdateCache(t.env), latest: "2.1.0" });
  t.answer("s");
  await launchUpdateCheck(context(), t.deps({ now: () => NOW + 31 * 24 * HOUR }));
  expect(t.calls.ask).toHaveLength(2);
  expect(t.calls.ask[1]).toContain("1.0.0 -> 2.1.0");
  expect(t.calls.upgrade).toBe(0);
});

test("given a fresh cache, then no refresh starts; a stale one starts exactly one and claims the window", async () => {
  const t = setup(fresh({ latest: "1.0.0" }));
  await launchUpdateCheck(context(), t.deps());
  expect(t.calls.refresh).toBe(0);
  const stale = setup({ checkedAt: NOW - UPDATE_TTL_MS, latest: "1.0.0" });
  await launchUpdateCheck(context(), stale.deps());
  await launchUpdateCheck(context(), stale.deps());
  expect(stale.calls.refresh).toBe(1);
  expect(readUpdateCache(stale.env).checkedAt).toBe(NOW);
  // No cache yet (first launch): refresh in the background, ask nothing now.
  const first = setup();
  expect(await launchUpdateCheck(context(), first.deps())).toBeUndefined();
  expect(first.calls).toEqual({ ask: [], upgrade: 0, reexec: [], refresh: 1 });
});

test("given the registry is offline, then the refresh stays silent and the launch asks nothing", async () => {
  const t = setup();
  refreshUpdateCache(t.env, {
    run: () => ({
      status: 1,
      stdout: "",
      stderr: "ENOTFOUND registry.npmjs.org",
    }),
    now: () => NOW,
  });
  expect(readUpdateCache(t.env)).toEqual({ checkedAt: NOW });
  expect(await launchUpdateCheck(context(), t.deps())).toBeUndefined();
  expect(t.calls).toEqual({ ask: [], upgrade: 0, reexec: [], refresh: 0 });
  expect(t.written).toEqual([]);
  // A throwing runner is just as quiet.
  refreshUpdateCache(t.env, {
    run: () => {
      throw new Error("spawn npm ENOENT");
    },
    now: () => NOW,
  });
  // Online: the latest version lands in the cache, other fields kept.
  writeUpdateCache(t.env, { skipped: "1.5.0" });
  refreshUpdateCache(t.env, {
    run: (command, args) => {
      expect([command, ...args]).toEqual(["npm", "view", "@brainervirus/workit-cli", "version"]);
      return { status: 0, stdout: "2.0.0\n" };
    },
    now: () => NOW,
  });
  expect(readUpdateCache(t.env)).toEqual({
    skipped: "1.5.0",
    checkedAt: NOW,
    latest: "2.0.0",
  });
});

test("given updates=auto, then it upgrades without asking and re-runs; a failed upgrade still runs the command", async () => {
  const t = setup(fresh(), { locale: "en", updates: "auto" });
  expect(await launchUpdateCheck(context(), t.deps())).toBe(7);
  expect(t.calls.ask).toEqual([]);
  expect(t.written.join("")).toContain("upgrading 1.0.0 -> 2.0.0");
  expect(t.calls.reexec).toEqual([["status", "--all"]]);

  const failing = setup(fresh(), { updates: "auto" });
  failing.upgradeFails();
  expect(await launchUpdateCheck(context(), failing.deps())).toBeUndefined();
  expect(failing.calls.upgrade).toBe(1);
  expect(failing.calls.reexec).toEqual([]);
  expect(failing.written.join("")).toContain("running your command with 1.0.0");
  // One attempt per window: the next launch does not upgrade again.
  await launchUpdateCheck(context(), failing.deps({ now: () => NOW + HOUR }));
  expect(failing.calls.upgrade).toBe(1);
});

test("given updates=off, or the installed version is current, then nothing happens", async () => {
  const off = setup(fresh(), { updates: "off" });
  await launchUpdateCheck(context(), off.deps());
  expect(off.calls).toEqual({ ask: [], upgrade: 0, reexec: [], refresh: 0 });
  const current = setup(fresh());
  await launchUpdateCheck(context(), current.deps({ installed: "2.0.0" }));
  expect(current.calls.ask).toEqual([]);
});

const registry =
  (versions: Record<string, string>) =>
  (command: string, args: string[]): { status: number; stdout: string } => {
    if (command === "npm" && args[0] === "view" && versions[args[1]])
      return { status: 0, stdout: `${versions[args[1]]}\n` };
    return { status: 1, stdout: "" };
  };

test("given --check, then it prints installed vs latest and the apply command, changes nothing, exits 0", async () => {
  const t = setup(undefined, { locale: "en", updates: "auto" });
  const config = readFileSync(path.join(t.home, ".config/workit/config.json"), "utf8");
  // One installed host (Cursor's plugin files), already at its latest version.
  const cursorRoot = path.join(t.home, ".cursor/plugins/local/workit");
  mkdirSync(cursorRoot, { recursive: true });
  writeFileSync(
    path.join(cursorRoot, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cursor", version: "98.0.0" }),
  );
  let out = "";
  const deps = {
    home: t.home,
    env: t.env,
    run: registry({
      "@brainervirus/workit-cli": "99.0.0",
      "@brainervirus/workit-cursor": "98.0.0",
    }),
    out: { write: (text: string) => void (out += text) },
  };
  expect(await runUpgradeCommand(["--check"], deps)).toBe(0);
  expect(out).toContain(`  cli     ${pkg.version} -> 99.0.0  update available\n`);
  expect(out).toContain("  cursor  98.0.0 -> 98.0.0  current\n");
  expect(out).toContain("updates: auto");
  expect(out).toContain("Apply with: workit upgrade --yes");
  expect(out).toContain("nothing changed");
  expect(readFileSync(path.join(t.home, ".config/workit/config.json"), "utf8")).toBe(config);
  // The launch check reuses what --check learned.
  expect(readUpdateCache(t.env).latest).toBe("99.0.0");

  out = "";
  expect(await runUpgradeCommand(["--check", "--json"], deps)).toBe(0);
  expect(JSON.parse(out)).toEqual({
    updates: "auto",
    components: [
      {
        component: "cli",
        package: "@brainervirus/workit-cli",
        installed: pkg.version,
        latest: "99.0.0",
        status: "update",
      },
      {
        component: "cursor",
        package: "@brainervirus/workit-cursor",
        installed: "98.0.0",
        latest: "98.0.0",
        status: "current",
      },
    ],
    apply: "workit upgrade --yes",
  });

  // Offline: still exit 0, the registry is reported unavailable.
  out = "";
  expect(
    await runUpgradeCommand(["--check", "--json"], {
      ...deps,
      run: registry({}),
    }),
  ).toBe(0);
  expect(JSON.parse(out).components[0]).toMatchObject({
    latest: null,
    status: "unavailable",
  });
});

test("given --set-updates, then config.json keeps its other keys; a bad mode is a usage error", async () => {
  const t = setup(undefined, { locale: "es-CL", custom: { keep: true } });
  let out = "";
  const deps = {
    home: t.home,
    env: t.env,
    out: { write: (text: string) => void (out += text) },
  };
  expect(await runUpgradeCommand(["--set-updates=off"], deps)).toBe(0);
  const file = path.join(t.home, ".config/workit/config.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    locale: "es-CL",
    custom: { keep: true },
    updates: "off",
  });
  expect(await runUpgradeCommand(["--set-updates=sometimes"], deps)).toBe(2);
  expect(await runUpgradeCommand(["--set-updates=auto", "--yes"], deps)).toBe(2);
  expect(await runUpgradeCommand(["--check", "--yes"], deps)).toBe(2);
  expect(JSON.parse(readFileSync(file, "utf8")).updates).toBe("off");
  // A fresh machine: the file is created.
  const bare = setup();
  expect(
    await runUpgradeCommand(["--set-updates=auto"], {
      home: bare.home,
      env: bare.env,
      out: deps.out,
    }),
  ).toBe(0);
  expect(existsSync(path.join(bare.home, ".config/workit/config.json"))).toBe(true);
});
