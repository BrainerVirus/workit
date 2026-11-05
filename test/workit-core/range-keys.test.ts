// rangeKeys computes a range's patch-id and diff hash from one `git diff`
// (#284 N6). Verdicts carry across rebases on the patch-id and are checked on
// the diff hash, so both must equal what patchId and diffHash give on their
// own, for every shape of change.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchId } from "@/packages/workit-core/src/git/rev";
import { diffHash, rangeKeys } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const binary = (seed: number) =>
  Buffer.from(Array.from({ length: 64 }, (_, i) => (i * seed) % 256));

const repo = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-range-keys-")));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  writeFileSync(path.join(dir, "blob.bin"), binary(3));
  writeFileSync(path.join(dir, "run.sh"), "echo hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "switch", "-q", "-c", "work");
  return dir;
};

const shapes: Record<string, (dir: string) => void> = {
  "a text edit": (dir) => writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n"),
  "a whitespace-only edit": (dir) => writeFileSync(path.join(dir, "a.txt"), "one\n  two\nthree\n"),
  "a new and a deleted file": (dir) => {
    writeFileSync(path.join(dir, "new.txt"), "fresh\n");
    unlinkSync(path.join(dir, "gone.txt"));
  },
  "a mode-only change": (dir) => chmodSync(path.join(dir, "run.sh"), 0o755),
  "a changed binary file": (dir) => writeFileSync(path.join(dir, "blob.bin"), binary(7)),
  "a new binary file beside a text edit": (dir) => {
    writeFileSync(path.join(dir, "img.bin"), binary(11));
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  },
};

for (const [shape, change] of Object.entries(shapes))
  test.skipIf(process.platform === "win32" && shape === "a mode-only change")(
    `Given ${shape}, Then rangeKeys equals patchId and diffHash computed apart`,
    () => {
      const dir = repo();
      change(dir);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", shape);
      const apart = {
        patchId: patchId(dir, "main", "work"),
        diffHash: diffHash(dir, "main", "work"),
      };
      expect(apart.diffHash).not.toBeNull();
      expect(rangeKeys(dir, "main", "work")).toEqual(apart);
    },
  );

test("Given an empty range and an unknown base, Then rangeKeys matches the separate calls (nulls)", () => {
  const dir = repo();
  expect(rangeKeys(dir, "main", "work")).toEqual({
    patchId: patchId(dir, "main", "work"),
    diffHash: diffHash(dir, "main", "work"),
  });
  expect(rangeKeys(dir, "no-such-base", "work")).toEqual({ patchId: null, diffHash: null });
});
