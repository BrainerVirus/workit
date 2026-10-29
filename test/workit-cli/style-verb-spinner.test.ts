// The verb spinners (progressFor) draw only on the process's own color
// terminal: a non-TTY stderr, a captured Io, --json, CI or NO_COLOR get no
// animation frames, so agent hosts and CI logs read the same bytes as before.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { progressFor } from "@/packages/workit-cli/src/progress";
import { run as gc } from "@/packages/workit-cli/src/verbs/gc";

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-verb-spinner-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
spawnSync("git", ["init", "-q", scratch]);

const FRAME = "\r\x1b[2K";
const ioWith = (
  stderr: { isTTY?: boolean; write: (t: string) => unknown } | undefined,
  extra: Partial<Io> = {},
): Io => ({
  json: false,
  cwd: scratch,
  env: { HOME: scratch, PATH: process.env.PATH },
  stdout: () => {},
  stderr: () => {},
  ...(stderr ? { terminals: { stderr } } : {}),
  ...extra,
});

test("Given a synchronous verb wait (gc), When stderr is not a TTY, Then it draws no frames; on a TTY it shows what it waits for", async () => {
  const quiet: string[] = [];
  expect(await gc(["--dry-run"], ioWith({ isTTY: false, write: (t) => quiet.push(t) }))).toBe(0);
  expect(await gc(["--dry-run"], ioWith(undefined))).toBe(0);
  expect(quiet).toEqual([]);
  const shown: string[] = [];
  expect(await gc(["--dry-run"], ioWith({ isTTY: true, write: (t) => shown.push(t) }))).toBe(0);
  expect(shown[0]).toContain("◐\x1b[0m Collecting garbage (0s)");
  expect(shown.at(-1)).toContain("Collecting garbage\n");
});

test("Given an asynchronous verb wait (pr, stack, release, youtrack), When the Io is not an interactive terminal, Then run draws nothing", async () => {
  const cases: Io[] = [];
  const writes: string[] = [];
  const write = (t: string) => void writes.push(t);
  cases.push(ioWith(undefined));
  cases.push(ioWith({ isTTY: false, write }));
  cases.push(ioWith({ isTTY: true, write }, { json: true }));
  cases.push(ioWith({ isTTY: true, write }, { env: { CI: "true" } }));
  for (const io of cases) {
    const value = await progressFor(io).run("Merging PR #1", async () => ({ ok: true }));
    expect(value).toEqual({ ok: true });
  }
  expect(writes).toEqual([]);
  // NO_COLOR on a terminal: one plain finished line, never an animation frame.
  await progressFor(ioWith({ isTTY: true, write }, { env: { NO_COLOR: "1" } })).run(
    "Merging PR #1",
    async () => 1,
  );
  expect(writes).toEqual(["✓ Merging PR #1\n"]);
  expect(writes.join("")).not.toContain(FRAME);
});
