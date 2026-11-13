import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeRoot } from "@/packages/workit-core/src/ledger";
import { resolveStore } from "@/packages/workit-core/src/store/paths";

// #835: the outside-git fallback never places a store under a directory that
// does not exist, so no later write recreates a removed checkout.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-store-paths-"));
  dirs.push(dir);
  return dir;
};

test("G a cwd naming a directory that does not exist, W the store is resolved, T it is an error and nothing is created", () => {
  const base = temp();
  const missing = path.join(base, "removed", "checkout");

  const located = resolveStore(missing);
  expect(located).toBeInstanceOf(Error);
  expect((located as Error).message).toContain(`${missing} does not exist`);

  const root = storeRoot(missing);
  expect(root.ok).toBe(false);
  if (!root.ok) expect(root.unblock).toContain("directory that exists");

  expect(existsSync(path.join(base, "removed"))).toBe(false);
});

test("G a non-git directory that exists, W the store is resolved, T it is <dir>/.workit as before", () => {
  const dir = temp();
  expect(resolveStore(dir)).toEqual({ dir: path.join(dir, ".workit"), shared: false, top: null });
});

test("G a path that exists but is a file, W the store is resolved, T the per-directory layout is kept", () => {
  const file = path.join(temp(), "plain.txt");
  writeFileSync(file, "x\n");
  expect(resolveStore(file)).toEqual({ dir: path.join(file, ".workit"), shared: false, top: null });
});
