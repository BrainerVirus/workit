import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitError, recoverFailedSwitch } from "@/packages/workit-core/src/git/ops";
import { dirtyPaths } from "@/packages/workit-core/src/core/branch";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});
const repo = (): RemoteRepo => {
  const made = makeRemoteRepo();
  repos.push(made);
  return made;
};
const killed = { ok: false, status: null, stdout: "", stderr: "", signal: "SIGKILL" as const };
const failed = { ok: false, status: 128, stdout: "", stderr: "fatal: x", signal: null };

test("a half-made branch at the base is deleted; a killed run keeps a lock and names the command", () => {
  const r = repo();
  const base = r.git("rev-parse", "HEAD");
  const lock = path.join(r.cwd, ".git", "index.lock");
  writeFileSync(lock, "");
  r.git("branch", "feature/half");
  const notes = recoverFailedSwitch(r.cwd, "feature/half", killed, {
    existed: false,
    baseSha: base,
  });
  expect(existsSync(lock)).toBe(true);
  expect(r.git("branch", "--list", "feature/half")).toBe("");
  // git reports the resolved path (/private/var on macOS, forward slashes on Windows).
  const printed = /rm (\S+index\.lock)/u.exec(notes.join(" "))?.[1] ?? "";
  expect(realpathSync(printed)).toBe(realpathSync(lock));
});

test("a branch that existed before, or moved off the base, is kept", () => {
  const r = repo();
  const base = r.git("rev-parse", "HEAD");
  r.git("branch", "feature/old");
  recoverFailedSwitch(r.cwd, "feature/old", failed, { existed: true, baseSha: base });
  expect(r.git("branch", "--list", "feature/old")).toContain("feature/old");
  recoverFailedSwitch(r.cwd, "feature/old", failed, { existed: false, baseSha: "0".repeat(40) });
  expect(r.git("branch", "--list", "feature/old")).toContain("feature/old");
});

test("a silent kill names the kill, not 'git failed'", () => {
  expect(gitError(killed)).toContain("SIGKILL");
  expect(gitError({ stderr: "fatal: boom\n", signal: null })).toBe("fatal: boom");
});

test("dirtyPaths lists tracked changes outside docs", () => {
  const r = repo();
  r.write("base-0.txt", "changed\n");
  expect(dirtyPaths(r.cwd)).toBe("base-0.txt");
});
