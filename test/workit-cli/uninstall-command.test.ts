import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

// Task 9 (`workit uninstall`): TTY-only interactive host picker + reviewable
// action summary BEFORE mutation (D-08); non-TTY stdin prints guidance and
// exits 2 (CA-10); exits 0 ok / 1 partial failure / 2 usage (CA-13).
//
// USER-SAFETY HARD CONSTRAINT: every run below executes against a temp fixture
// home injected through process.env.HOME (the same injectable-homes seam the
// Task 8 core module resolves), so the real ~/.config/workit, ~/.config/opencode
// and ~/.cursor are untouched by construction. Each fixture seeds a canary
// ~/.config/workit/config.json whose bytes must survive every scenario.

const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";

class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// Same ANSI-stripping scanner as clean-screen.test.ts so assertions see only
// visible text.
function clean(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === 0x1b) {
      i += 2;
      while (
        i < raw.length &&
        ((raw.charCodeAt(i) >= 0x30 && raw.charCodeAt(i) <= 0x3f) ||
          (raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f))
      ) {
        i += 1;
      }
      if (i < raw.length) i += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i += 1;
      continue;
    }
    out += raw[i];
    i += 1;
  }
  return out;
}

type Fixture = {
  home: string;
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  cursorPluginDir: string;
  workitConfigFile: string;
};

function makeFixture(): Fixture {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-uninstall-home-"));
  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
  const cursorSettings = path.join(home, ".cursor", "settings.json");
  const cursorMcp = path.join(home, ".cursor", "mcp.json");
  const cursorPluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
  const workitConfigFile = path.join(home, ".config", "workit", "config.json");
  mkdirSync(path.dirname(opencodeConfig), { recursive: true });
  mkdirSync(path.join(cursorPluginDir, "dist"), { recursive: true });
  mkdirSync(path.dirname(workitConfigFile), { recursive: true });
  writeFileSync(
    opencodeConfig,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: ["@brainervirus/workit-opencode", "other-plugin"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    cursorSettings,
    `${JSON.stringify({ enabled_plugins: { workit: true }, theme: "dark" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    cursorMcp,
    `${JSON.stringify(
      { mcpServers: { workit: { command: "npx" }, other: { command: "uvx" } } },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(path.join(cursorPluginDir, "dist", "mcp-server.js"), "bundle-bytes", "utf8");
  writeFileSync(workitConfigFile, '{"canary":"workit-config"}\n', "utf8");
  return { home, opencodeConfig, cursorSettings, cursorMcp, cursorPluginDir, workitConfigFile };
}

async function driveUninstall(
  keys: string[],
  home?: string,
): Promise<{ chunks: string[]; exitCode: number | undefined }> {
  const prevHome = process.env.HOME;
  const prevWrite = process.stdout.write;
  const prevExit = process.exit;
  const prevLog = console.log;
  const prevStdin = process.stdin;
  const stdoutFlags = process.stdout as unknown as Record<string, unknown>;
  const prevFlags = {
    isTTY: stdoutFlags.isTTY,
    columns: stdoutFlags.columns,
    rows: stdoutFlags.rows,
  };
  const fakeStdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref(): void;
    unref(): void;
    setRawMode(enabled: boolean): void;
  };
  fakeStdin.isTTY = true;
  fakeStdin.ref = () => {};
  fakeStdin.unref = () => {};
  fakeStdin.setRawMode = () => {};

  const chunks: string[] = [];
  let exitCode: number | undefined;
  try {
    if (home !== undefined) process.env.HOME = home;
    process.stdin = fakeStdin as unknown as typeof process.stdin;
    stdoutFlags.isTTY = true;
    stdoutFlags.columns = 120;
    stdoutFlags.rows = 40;
    process.stdout.write = ((chunk: unknown, cb?: (() => void) | undefined) => {
      chunks.push(String(chunk));
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    };
    process.exit = ((code?: number) => {
      throw new ExitSentinel(code);
    }) as typeof process.exit;

    const { runUninstall } = await import("../../packages/workit-cli/src/index");
    // Real-timer beat per step: ink throttles frame writes on wall-clock timers.
    const flush = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const running = runUninstall();
    running.catch(() => {});
    await flush();
    for (const key of keys) {
      process.stdin.push(key);
      await flush();
    }
    try {
      await running;
    } catch (err) {
      if (!(err instanceof ExitSentinel)) throw err;
      exitCode = err.code;
    }
    return { chunks, exitCode };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.stdout.write = prevWrite;
    process.exit = prevExit;
    console.log = prevLog;
    process.stdin = prevStdin;
    stdoutFlags.isTTY = prevFlags.isTTY;
    stdoutFlags.columns = prevFlags.columns;
    stdoutFlags.rows = prevFlags.rows;
  }
}

test("uninstall removes only the selected host and preserves unselected hosts + ~/.config/workit byte-for-byte", async () => {
  const fx = makeFixture();
  try {
    const cursorBefore = readFileSync(fx.cursorSettings, "utf8");
    const mcpBefore = readFileSync(fx.cursorMcp, "utf8");
    const workitBefore = readFileSync(fx.workitConfigFile, "utf8");

    const { chunks, exitCode } = await driveUninstall([SPACE, ENTER, "y"], fx.home);

    expect(exitCode, clean(chunks.join(""))).toBe(0);
    const joined = clean(chunks.join(""));
    // D-08: the reviewable action summary was shown before the mutation.
    expect(joined).toContain("Apply uninstall?");
    expect(joined).toContain("remove workit plugin entries from opencode.json");
    expect(joined).toContain(fx.opencodeConfig);

    // OpenCode: the workit plugin entry is gone; unrelated entries stay.
    const oc = JSON.parse(readFileSync(fx.opencodeConfig, "utf8")) as {
      plugin: string[];
      $schema: string;
    };
    expect(oc.plugin).toEqual(["other-plugin"]);
    expect(oc.$schema).toBe("https://opencode.ai/config.json");

    // Unselected Cursor host: byte-level preservation, plugin dir still present.
    expect(readFileSync(fx.cursorSettings, "utf8")).toBe(cursorBefore);
    expect(readFileSync(fx.cursorMcp, "utf8")).toBe(mcpBefore);
    expect(existsSync(path.join(fx.cursorPluginDir, "dist", "mcp-server.js"))).toBe(true);

    // ~/.config/workit is never touched.
    expect(readFileSync(fx.workitConfigFile, "utf8")).toBe(workitBefore);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("selecting both hosts removes every registration while keeping ~/.config/workit", async () => {
  const fx = makeFixture();
  try {
    const workitBefore = readFileSync(fx.workitConfigFile, "utf8");

    const { chunks, exitCode } = await driveUninstall([SPACE, DOWN, SPACE, ENTER, "y"], fx.home);

    expect(exitCode, clean(chunks.join(""))).toBe(0);
    const joined = clean(chunks.join(""));
    expect(joined).toContain("Apply uninstall?");
    expect(joined).toContain("delete the local workit plugin directory");

    const oc = JSON.parse(readFileSync(fx.opencodeConfig, "utf8")) as { plugin: string[] };
    expect(oc.plugin).toEqual(["other-plugin"]);
    const settings = JSON.parse(readFileSync(fx.cursorSettings, "utf8")) as {
      enabled_plugins: Record<string, boolean>;
      theme: string;
    };
    expect(settings.enabled_plugins).not.toHaveProperty("workit");
    expect(settings.theme).toBe("dark");
    const mcp = JSON.parse(readFileSync(fx.cursorMcp, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers).not.toHaveProperty("workit");
    expect(mcp.mcpServers).toHaveProperty("other");
    expect(existsSync(fx.cursorPluginDir)).toBe(false);
    expect(joined).toContain("Uninstall complete.");

    expect(readFileSync(fx.workitConfigFile, "utf8")).toBe(workitBefore);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
}, 30_000);

test("declining the review confirm mutates nothing and exits 0", async () => {
  const fx = makeFixture();
  try {
    const snapshots = [fx.opencodeConfig, fx.cursorSettings, fx.cursorMcp, fx.workitConfigFile].map(
      (f) => [f, readFileSync(f, "utf8")],
    );

    const { chunks, exitCode } = await driveUninstall([SPACE, ENTER, "n"], fx.home);

    expect(exitCode).toBe(0);
    expect(clean(chunks.join(""))).toContain("nothing was changed");
    for (const [file, before] of snapshots) {
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(existsSync(fx.cursorPluginDir)).toBe(true);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("partial failure exits 1: malformed selected file fails untouched, healthy host still uninstalls", async () => {
  const fx = makeFixture();
  try {
    const malformed = "{ not json";
    writeFileSync(fx.opencodeConfig, malformed, "utf8");
    const workitBefore = readFileSync(fx.workitConfigFile, "utf8");

    const { chunks, exitCode } = await driveUninstall([SPACE, DOWN, SPACE, ENTER, "y"], fx.home);

    expect(exitCode, clean(chunks.join(""))).toBe(1);
    const joined = clean(chunks.join(""));
    expect(joined).toContain("Uninstall finished with problems.");
    // The malformed file failed its own action untouched (CA-13)…
    expect(readFileSync(fx.opencodeConfig, "utf8")).toBe(malformed);
    // …while the healthy Cursor host completed its removal.
    const settings = JSON.parse(readFileSync(fx.cursorSettings, "utf8")) as {
      enabled_plugins: Record<string, boolean>;
    };
    expect(settings.enabled_plugins).not.toHaveProperty("workit");
    expect(existsSync(fx.cursorPluginDir)).toBe(false);
    expect(readFileSync(fx.workitConfigFile, "utf8")).toBe(workitBefore);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
}, 30_000);

test("non-TTY stdin prints guidance and exits 2 without touching anything (CA-10)", async () => {
  const prevStdin = process.stdin;
  const prevWrite = process.stdout.write;
  const prevExit = process.exit;
  const prevLog = console.log;
  const stdoutFlags = process.stdout as unknown as Record<string, unknown>;
  const prevIsTTY = stdoutFlags.isTTY;
  const chunks: string[] = [];
  let exitCode: number | undefined;
  try {
    const plainStdin = new PassThrough() as PassThrough & { isTTY: boolean };
    plainStdin.isTTY = false;
    process.stdin = plainStdin as unknown as typeof process.stdin;
    stdoutFlags.isTTY = false;
    process.stdout.write = ((chunk: unknown, cb?: (() => void) | undefined) => {
      chunks.push(String(chunk));
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    };
    process.exit = ((code?: number) => {
      throw new ExitSentinel(code);
    }) as typeof process.exit;

    const { runUninstall } = await import("../../packages/workit-cli/src/index");
    try {
      await runUninstall();
    } catch (err) {
      if (!(err instanceof ExitSentinel)) throw err;
      exitCode = err.code;
    }
    expect(exitCode).toBe(2);
    const joined = chunks.join("");
    expect(joined).toContain("interactive terminal");
    expect(joined).toContain("~/.config/workit");
  } finally {
    process.stdin = prevStdin;
    process.stdout.write = prevWrite;
    process.exit = prevExit;
    console.log = prevLog;
    stdoutFlags.isTTY = prevIsTTY;
  }
});
