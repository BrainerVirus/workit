import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
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

test("a killed git switch leaves no index.lock and no half-made branch", () => {
  const r = repo();
  const lock = path.join(r.cwd, ".git", "index.lock");
  const started = Date.now();
  writeFileSync(lock, "");
  r.git("branch", "feature/half");
  const undone = recoverFailedSwitch(r.cwd, "feature/half", killed, started);
  expect(existsSync(lock)).toBe(false);
  expect(r.git("branch", "--list", "feature/half")).toBe("");
  expect(undone.join(" ")).toContain("index.lock");
});

test("a lock from another git process is left alone", () => {
  const r = repo();
  const lock = path.join(r.cwd, ".git", "index.lock");
  writeFileSync(lock, "");
  const failed = {
    ...killed,
    signal: null,
    status: 128,
    stderr: "fatal: Unable to create index.lock",
  };
  recoverFailedSwitch(r.cwd, "feature/x", failed, Date.now() + 60_000);
  expect(existsSync(lock)).toBe(true);
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
