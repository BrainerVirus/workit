import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { samePath } from "@/test/helpers/same-path";

// samePath compares where two paths resolve to, not how they are spelled.

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-same-path-")));
  mkdirSync(path.join(root, "real", "x"), { recursive: true });
  symlinkSync(path.join(root, "real"), path.join(root, "link"), "dir");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("G a symlink and its target, W samePath runs, T they are the same path", () => {
  expect(samePath(path.join(root, "link", "x"), path.join(root, "real", "x"))).toBe(true);
});

test("G a path with and without the symlink spelled, W samePath runs, T true", () => {
  expect(samePath(path.join(root, "real", "x"), path.join(root, "real", "x"))).toBe(true);
});

test("G Windows separators against forward slashes, W samePath runs, T true", () => {
  expect(samePath("C:\\a\\b", "C:/a/b")).toBe(true);
});

test("G unrelated paths, W samePath runs, T false", () => {
  expect(samePath(path.join(root, "real", "x"), path.join(root, "real"))).toBe(false);
  expect(samePath("C:\\a\\b", "C:/a/c")).toBe(false);
  expect(samePath(path.join(root, "missing-a"), path.join(root, "missing-b"))).toBe(false);
});
