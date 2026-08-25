import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

// CA-02 (clean screen): runInit must open with exactly one clear
// (\x1b[2J\x1b[H) before the wizard renders and emit exactly one more after
// waitUntilExit() resolves — before any Apply-summary / blocked / cancel
// output — so post-exit text never sits atop leftover wizard frames.
//
// runInit renders to the real process.stdout/stdin (no stream injection), so
// the drive below patches those globals for the duration of one run:
// process.stdout.write and console.log are recorded into a single ordered
// timeline, the un-drivable real stdin (bun ignores push()) is swapped for a
// TTY-shaped PassThrough exactly like test/shared/helpers/ink-tty.ts builds,
// and process.exit throws a sentinel so each runInit exit path is observable
// without killing the test runner. The clear sequence under test stays on its
// literal target: process.stdout.write.

const CLEAR = "\x1b[2J\x1b[H";
const ENTER = "\r";
const SPACE = " ";
// Ink's input parser emits the first two ESCs of a triple-ESC chunk as an
// escape keypress synchronously (a leading pair can't start a CSI sequence);
// a lone or doubled ESC is held "pending" for a 20 ms wall-clock disambiguation
// timer that setImmediate-only flushing never reaches.
const ESC = "\x1b\x1b\x1b";

class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// Same scanner approach as test/shared/helpers/ink-tty.ts: strips ANSI escape
// sequences and control characters so assertions see visible text only.
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

type DriveResult = { chunks: string[]; exitCode?: number };

async function driveRunInit(keys: string[]): Promise<DriveResult> {
  const base = mkdtempSync(path.join(os.tmpdir(), "workit-clean-"));
  const configPath = path.join(base, "config");
  mkdirSync(configPath, { recursive: true });
  process.env.WORKFLOW_TOOLKIT_CONFIG = configPath;
  const prevWorkspaceRoot = process.env.WORKFLOW_WORKSPACE_ROOT;
  // Non-git resolution root keeps the branch-policy screen out of the walk.
  process.env.WORKFLOW_WORKSPACE_ROOT = path.join(
    os.tmpdir(),
    `workit-clean-nongit-${process.pid}`,
  );

  const prevWrite = process.stdout.write;
  const prevExit = process.exit;
  const prevLog = console.log;
  const prevStdin = process.stdin;
  const prevStdoutIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
  const prevStdoutColumns = (process.stdout as { columns?: number }).columns;
  const prevStdoutRows = (process.stdout as { rows?: number }).rows;

  // Same TTY-shaped fake stdin the ink-tty harness builds.
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
    process.stdin = fakeStdin as unknown as typeof process.stdin;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    (process.stdout as { columns: number }).columns = 120;
    (process.stdout as { rows: number }).rows = 40;
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

    const { runInit } = await import("../../packages/workit-cli/src/index");
    // A real-timer beat per step: ink throttles frame writes on wall-clock
    // timers, so setImmediate-only flushing observes stale screens.
    const flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const running = runInit();
    // Attach a no-op handler immediately so bun does not report an
    // unhandled rejection while the key loop below is still awaiting.
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
    delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    if (prevWorkspaceRoot === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = prevWorkspaceRoot;
    process.stdout.write = prevWrite;
    process.exit = prevExit;
    console.log = prevLog;
    process.stdin = prevStdin;
    const stdout = process.stdout as { isTTY?: boolean; columns?: number; rows?: number };
    stdout.isTTY = prevStdoutIsTTY;
    stdout.columns = prevStdoutColumns;
    stdout.rows = prevStdoutRows;
    rmSync(base, { recursive: true, force: true });
  }
}

function clearCount(joined: string): number {
  let count = 0;
  let at = joined.indexOf(CLEAR);
  while (at !== -1) {
    count += 1;
    at = joined.indexOf(CLEAR, at + CLEAR.length);
  }
  return count;
}

test("apply path: first chunk clears, exactly one post-exit clear precedes the first summary line", async () => {
  const { chunks, exitCode } = await driveRunInit([
    SPACE,
    ENTER, // platforms -> locale
    ENTER, // locale -> timezone
    ENTER, // timezone -> branchPreset
    ENTER, // branchPreset -> issueTracker
    ENTER, // issueTracker (YouTrack) -> youtrack
    "https://yt.example.com",
    ENTER, // youtrack -> vcs
    ENTER, // vcs -> workspaces
    ENTER, // workspaces (Done) -> project
    "y", // project -> summary
    "y", // apply
  ]);
  expect(exitCode).toBe(0);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0].startsWith(CLEAR)).toBe(true);

  const joined = chunks.join("");
  expect(clearCount(joined)).toBe(2);
  const second = joined.indexOf(CLEAR, CLEAR.length);
  expect(second).toBeGreaterThan(0);

  // Nothing summary-like before the post-exit clear.
  expect(clean(joined.slice(CLEAR.length, second))).not.toContain("Setup complete.");

  // The first visible line after the clear is an Apply-summary entry line,
  // never leftover wizard frame content.
  const tail = clean(joined.slice(second + CLEAR.length));
  const tailLines = tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  expect(tailLines[0]).toMatch(/^(Installed|Configured|Skipped|Failed)\b/);
  expect(tail).toContain("Setup complete.");
});

test("cancel path: still exactly two clears; exit output never sits atop stale frames", async () => {
  const { chunks, exitCode } = await driveRunInit([
    SPACE,
    ENTER, // platforms -> locale
    ESC, // cancel from the select screen
  ]);
  expect(exitCode).toBe(1);

  const joined = chunks.join("");
  expect(chunks[0].startsWith(CLEAR)).toBe(true);
  expect(clearCount(joined)).toBe(2);
  const second = joined.indexOf(CLEAR, CLEAR.length);
  expect(second).toBeGreaterThan(0);

  // Wizard frames really rendered between the two clears (the post-exit clear
  // is not just a duplicate of the pre-render one).
  expect(clean(joined.slice(CLEAR.length, second))).toContain("Locale");

  // Cancel prints no summary; nothing follows the final clear.
  expect(clean(joined.slice(second + CLEAR.length)).trim()).toBe("");
});
