import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTree } from "@/packages/workit-core/src/core/remove-tree";

const fail = (code: string) => Object.assign(new Error(`${code}: rm`), { code });

/** An rm that throws each queued code in turn, then succeeds. */
function flakyRm(codes: string[]) {
  const calls: number[] = [];
  const rm = () => {
    calls.push(performance.now());
    const code = codes.shift();
    if (code) throw fail(code);
  };
  return { rm, calls };
}

test("Given an rm that fails EBUSY twice, When removeTree runs with 3 attempts, Then the third try removes it after growing waits", () => {
  const { rm, calls } = flakyRm(["EBUSY", "EBUSY"]);
  removeTree("/nowhere", { attempts: 3, delayMs: 20, rm });
  expect(calls).toHaveLength(3);
  const [first = 0, second = 0, third = 0] = calls;
  expect(second - first).toBeGreaterThanOrEqual(18);
  expect(third - second).toBeGreaterThanOrEqual(38);
});

test("Given an rm that fails EACCES, When removeTree runs, Then it rethrows at once without retrying", () => {
  const { rm, calls } = flakyRm(["EACCES"]);
  expect(() => removeTree("/nowhere", { attempts: 5, delayMs: 1000, rm })).toThrow("EACCES");
  expect(calls).toHaveLength(1);
});

test("Given an rm that keeps failing ENOTEMPTY, When the attempts run out, Then the last error is rethrown", () => {
  const { rm, calls } = flakyRm(["ENOTEMPTY", "EMFILE", "ENFILE", "EPERM"]);
  expect(() => removeTree("/nowhere", { attempts: 3, delayMs: 1, rm })).toThrow("ENFILE");
  expect(calls).toHaveLength(3);
});

test("Given a real nested tree, When removeTree runs with the default rm, Then the tree is gone and a missing dir is no error", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "remove-tree-"));
  mkdirSync(path.join(root, "a", "b"), { recursive: true });
  writeFileSync(path.join(root, "a", "b", "f"), "x");
  removeTree(root);
  expect(existsSync(root)).toBe(false);
  expect(() => removeTree(root)).not.toThrow();
});
