import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// #463: a test that dispatches a SubagentStart records an issued session id in
// the Workit state dir. Without its own WORKFLOW_TOOLKIT_STATE the ids leak
// into the run-wide registry and later tests see them, which turned main red.

const TEST_ROOT = path.resolve(import.meta.dir, "../..");

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return entry.name.endsWith(".test.ts") ? [full] : [];
  });

const DISPATCHES_SUBAGENT_START =
  /["']subagent-start["']|(?<![A-Za-z_])agent_type["']?\s*:\s*["']workit:(?:verifier|reviewer)["']/u;

test("every test file that dispatches a SubagentStart sets WORKFLOW_TOOLKIT_STATE", () => {
  const self = path.resolve(import.meta.filename);
  const unisolated = testFiles(TEST_ROOT)
    .filter((file) => path.resolve(file) !== self)
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return DISPATCHES_SUBAGENT_START.test(text) && !text.includes("WORKFLOW_TOOLKIT_STATE");
    })
    .map((file) => path.relative(TEST_ROOT, file));
  expect(unisolated).toEqual([]);
});
