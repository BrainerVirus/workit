import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@/packages/workit-core/src/core/safe-write";

describe("writeFileAtomic", () => {
  test("replaces a regular file and preserves its mode", () => {
    const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "workit-safe-write-"));
    try {
      const file = path.join(root, "config.json");
      writeFileSync(file, "before");
      chmodSync(file, 0o640);

      writeFileAtomic(file, "after\n");

      expect(readFileSync(file, "utf8")).toBe("after\n");
      if (process.platform !== "win32") expect(lstatSync(file).mode & 0o777).toBe(0o640);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses symlink targets and ancestors without changing their referents", () => {
    const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "workit-safe-write-"));
    try {
      const outside = path.join(root, "outside.json");
      const targetLink = path.join(root, "target-link.json");
      const dirLink = path.join(root, "dir-link");
      writeFileSync(outside, "preserved\n");
      symlinkSync(outside, targetLink);
      symlinkSync(root, dirLink);

      expect(() => writeFileAtomic(targetLink, "changed\n")).toThrow(/non-regular file/);
      expect(() => writeFileAtomic(path.join(dirLink, "child.json"), "changed\n")).toThrow(
        /symlinked write path/,
      );
      expect(readFileSync(outside, "utf8")).toBe("preserved\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
