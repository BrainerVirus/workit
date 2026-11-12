// #780, decision for PR #827: one test decides whether a command may run
// ytrack, the gate's own first test (hooks/ytrack-word.ts), copied byte for byte
// into both launchers; every shape the gate decides passes it.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { namesYtrack, YTRACK_WORD } from "@/packages/workit-core/src/hooks/ytrack-word";
import { tempRoot } from "./hook-fixtures";
import { FAST, POSIX_SHAPES, POWERSHELL_SHAPES, ROUTED_MENTIONS } from "./ytrack-shapes";

const ROOT = path.resolve(import.meta.dir, "../../..");
const base = realpathSync(tempRoot("workit-ytrack-word-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = path.join(base, "config");
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("G every shape a ytrack write can take, W the gate and the shared test read it, T the gate decides it and the test names ytrack", () => {
  for (const [dialect, shapes] of [
    ["posix", POSIX_SHAPES],
    ["powershell", POWERSHELL_SHAPES],
  ] as const)
    for (const shape of shapes) {
      expect(ytrackGate(root, shape, dialect, false), `${dialect}: ${shape}`).not.toBeNull();
      expect(namesYtrack(shape), `${dialect}: ${shape}`).toBe(true);
    }
});

test("G commands that only mention ytrack, W the shared test reads them, T paths and longer names stay unnamed, a bare word is named and the gate passes it", () => {
  for (const command of FAST) expect(namesYtrack(command), command).toBe(false);
  for (const command of ROUTED_MENTIONS) {
    expect(namesYtrack(command), command).toBe(true);
    expect(ytrackGate(root, command, "posix", true), command).toBeNull();
  }
});

test("G both launchers, W their sources are read, T each holds the shared test byte for byte", () => {
  for (const launcher of [
    "packages/workit-claude-code/bin/workit-hook.mjs",
    "packages/workit-codex/hooks/launcher.ts",
  ]) {
    const source = readFileSync(path.join(ROOT, launcher), "utf8");
    expect(source, launcher).toContain(`const YTRACK_WORD = ${String(YTRACK_WORD)};`);
    expect(source, launcher).toContain(`const bare = text.replace(/['"\\\\]/g, "");`);
    expect(source, launcher).toContain(
      'return YTRACK_WORD.test(bare) || YTRACK_WORD.test(bare.replace(/`/g, ""));',
    );
  }
});
