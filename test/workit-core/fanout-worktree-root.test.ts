import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeRoot } from "@/packages/workit-core/src/fanout";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const repo = (parent: string, name: string): string => {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

test.skipIf(process.platform === "win32")(
  "Given the state dir is reached through a symlink, When the root is planned, Then it is the real path git reports (macOS /var -> /private/var)",
  () => {
    const real = temp("wk-root-real-");
    const link = path.join(temp("wk-root-link-"), "state");
    symlinkSync(real, link);
    const lead = repo(temp("wk-root-repo-"), "app");
    const root = worktreeRoot(lead, { WORKIT_STATE_DIR: link });
    expect(root).toBe(path.join(realpathSync.native(real), "worktrees", "app"));
  },
);

test("Given a checkout already has its tagged dir, When the other repository's worktrees are gone, Then it keeps the tagged dir", () => {
  const state = temp("wk-root-state-");
  const env = { WORKIT_STATE_DIR: state };
  const lead = repo(temp("wk-root-a-"), "app");
  const other = repo(temp("wk-root-b-"), "app");
  // The other repository holds the plain name: a worktree whose .git points into it.
  const plain = worktreeRoot(other, env);
  mkdirSync(path.join(plain, "s1"), { recursive: true });
  writeFileSync(
    path.join(plain, "s1", ".git"),
    `gitdir: ${path.join(other, ".git", "worktrees", "s1")}\n`,
  );
  const tagged = worktreeRoot(lead, env);
  expect(path.basename(tagged)).toMatch(/^app-[0-9a-f]{8}$/u);
  mkdirSync(tagged, { recursive: true });
  // The other repository leaves; this checkout must not flip back to the plain name.
  rmSync(plain, { recursive: true, force: true });
  expect(worktreeRoot(lead, env)).toBe(tagged);
});
