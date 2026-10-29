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
  // The fake upgrade: its exit code, the hosts it reports failed, and whether
  // it replaced the CLI package on disk (what the re-exec depends on).
  let outcome = { code: 0, failed: [] as { host: string; fix?: string }[], replacesCli: true };
  let onDisk = "1.0.0";
  const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
    env,
    stdin: { isTTY: true },
    stdout: { isTTY: true },
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
      if (outcome.replacesCli) onDisk = "2.0.0";
      return { code: outcome.code, failed: outcome.failed };
    },
    cliOnDisk: () => onDisk,
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
    upgradeFails: () =>
      void (outcome = {
        code: 1,
        failed: [{ host: "cli", fix: "npm install --global @brainervirus/workit-cli@latest" }],
        replacesCli: false,
      }),
    hostFails: () =>
      void (outcome = {
        code: 1,
        failed: [{ host: "cursor", fix: "workit upgrade --hosts=cursor" }],
        replacesCli: true,
      }),
    cliUntouched: () => void (outcome = { code: 0, failed: [], replacesCli: false }),
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
    ["stdout redirected", { stdout: { isTTY: false } }, {}, {}],
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
  // The text form never calls an unchecked install current.
  out = "";
  const offlineDeps = { ...deps, run: registry({}) };
  expect(await runUpgradeCommand(["--check"], offlineDeps)).toBe(0);
  expect(out).toContain("Could not check: registry unavailable");
  expect(out).not.toContain("Everything is current.");
});

/** OpenCode registered with Workit, whose service reports the plugin through `opencode api plugin.list`. */
const opencodeService =
  (plugin: { version: string; outdated?: boolean }, versions: Record<string, string>) =>
  (command: string, args: string[]): { status: number; stdout: string } => {
    if (command === "opencode" && args.join(" ") === "api plugin.list")
      return {
        status: 0,
        stdout: JSON.stringify({
          location: { directory: "/home/user" },
          data: [
            { id: "builtin-auth", source: { type: "builtin" }, state: { status: "active" } },
            {
              id: "workit",
              source: {
                type: "package",
                target: "@brainervirus/workit-opencode",
                version: plugin.version,
                ...(plugin.outdated ? { outdated: true } : {}),
              },
              state: { status: "active" },
            },
          ],
        }),
      };
    return registry(versions)(command, args);
  };

const registerOpencode = (home: string) => {
  mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  writeFileSync(
    path.join(home, ".config/opencode/opencode.json"),
    JSON.stringify({ plugin: ["@brainervirus/workit-opencode"] }),
  );
};

test("given --check with OpenCode, then the installed version and the outdated flag come from opencode api plugin.list", async () => {
  const t = setup(undefined, { locale: "en", updates: "prompt" });
  registerOpencode(t.home);
  let out = "";
  const deps = {
    home: t.home,
    env: t.env,
    run: opencodeService(
      { version: "8.44.0", outdated: true },
      { "@brainervirus/workit-cli": pkg.version, "@brainervirus/workit-opencode": "8.44.1" },
    ),
    out: { write: (text: string) => void (out += text) },
  };
  expect(await runUpgradeCommand(["--check"], deps)).toBe(0);
  expect(out).toMatch(/ opencode +8\.44\.0 -> 8\.44\.1 +update available\n/);
  expect(out).not.toContain("installed version unknown");
  // Same version on the registry, but OpenCode says the plugin is outdated.
  out = "";
  expect(
    await runUpgradeCommand(["--check", "--json"], {
      ...deps,
      run: opencodeService(
        { version: "8.44.0", outdated: true },
        { "@brainervirus/workit-cli": pkg.version, "@brainervirus/workit-opencode": "8.44.0" },
      ),
    }),
  ).toBe(0);
  expect(JSON.parse(out).components).toContainEqual({
    component: "opencode",
    package: "@brainervirus/workit-opencode",
    installed: "8.44.0",
    latest: "8.44.0",
    status: "update",
  });
});

test("given --check where every probe takes 1 s, then the probes run at once behind one Checking spinner", async () => {
  const t = setup(undefined, { locale: "en", updates: "prompt" });
  registerOpencode(t.home);
  const run = opencodeService(
    { version: "8.44.1" },
    {
      "@brainervirus/workit-cli": pkg.version,
      "@brainervirus/workit-opencode": "8.44.1",
      "@brainervirus/workit-cursor": "8.44.1",
      "@brainervirus/workit-codex": "8.44.1",
      "@brainervirus/workit-pi": "8.44.1",
      "@brainervirus/workit-claude-code": "8.44.1",
    },
  );
  let probes = 0;
  const labels: string[] = [];
  let out = "";
  const began = Date.now();
  expect(
    await runUpgradeCommand(["--check"], {
      home: t.home,
      env: t.env,
      run,
      runAsync: async (command, args) => {
        probes++;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return run(command, args);
      },
      progress: {
        mode: "plain",
        start: () => ({ label: () => {}, end: () => {} }),
        run: (label, fn) => {
          labels.push(label);
          return fn();
        },
        runSync: (_label, fn) => fn(),
      },
      out: { write: (text: string) => void (out += text) },
    }),
  ).toBe(0);
  // Sequential, these probes would take one second each.
  expect(probes).toBeGreaterThanOrEqual(5);
  expect(Date.now() - began).toBeLessThan(3_000);
  expect(labels).toEqual(["Checking 6 hosts"]);
  expect(out).toMatch(/ opencode +8\.44\.1 -> 8\.44\.1 +current\n/);
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

test("given Ctrl-C or Ctrl-D at the prompt, then it prints Cancelled., exits 130, runs nothing and records nothing", async () => {
  for (const name of ["AbortError", "ABORT_ERR"]) {
    const t = setup(fresh());
    const before = readFileSync(t.cacheFile, "utf8");
    const abort = Object.assign(new Error("The operation was aborted"), {
      name: name === "AbortError" ? "AbortError" : "Error",
      code: name,
    });
    const result = await launchUpdateCheck(
      context(),
      t.deps({
        ask: async () => {
          throw abort;
        },
      }),
    );
    expect(result).toBe(130);
    expect(t.written.join("")).toBe("\nCancelled.\n");
    expect(t.calls.upgrade).toBe(0);
    expect(t.calls.reexec).toEqual([]);
    expect(readFileSync(t.cacheFile, "utf8")).toBe(before);
  }
});

test("given a host fails but the CLI package was replaced, then it names the host and its fix and re-runs on the new CLI", async () => {
  const t = setup(fresh(), { updates: "auto" });
  t.hostFails();
  expect(await launchUpdateCheck(context(), t.deps())).toBe(7);
  expect(t.calls.reexec).toEqual([["status", "--all"]]);
  expect(t.written.join("")).toContain(
    "Upgrade incomplete: cursor failed (fix: workit upgrade --hosts=cursor)",
  );
});

test("given an upgrade that leaves the CLI package as it was, then it never re-executes (no loop)", async () => {
  const t = setup(fresh());
  t.answer("u");
  t.cliUntouched();
  expect(await launchUpdateCheck(context(), t.deps())).toBeUndefined();
  expect(t.calls.upgrade).toBe(1);
  expect(t.calls.reexec).toEqual([]);
});
