// Hardened makeForgeRepo for forge.test.ts. On Windows CI a fixture
// `git commit` failed with an empty stderr (run 37709024507): the shared
// helper's error message dropped the exit status, signal and spawn error, so
// the cause was invisible. This builder pins the config that differs per
// runner (core.autocrlf, background auto-gc) and reports everything git said.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForgeRepo } from "@/test/shared/helpers/forge-replay";

const GIT_CONFIG = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "gc.auto=0",
];

const describeFailure = (args: string[], result: SpawnSyncReturns<string>): string =>
  [
    `git ${args.join(" ")} failed`,
    `status=${result.status} signal=${result.signal ?? "none"}`,
    result.error ? `error=${result.error.message}` : "",
    `stderr=${result.stderr || "(empty)"}`,
    `stdout=${result.stdout || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");

const run = (cwd: string, args: string[]): SpawnSyncReturns<string> =>
  spawnSync("git", [...GIT_CONFIG, ...args], { cwd, encoding: "utf8" });

const git = (cwd: string, ...args: string[]): string => {
  let result = run(cwd, args);
  // Retry once only when git never ran to an exit code (spawn error or
  // killed by a signal); a real non-zero exit fails immediately.
  if (result.error || result.status === null) result = run(cwd, args);
  if (result.status !== 0) throw new Error(describeFailure(args, result));
  return result.stdout.trim();
};

/**
 * A checkout whose fetch URL is a local bare repo and whose push URL is the
 * forge (https, so no ~/.ssh/config alias lookup): the forge is derived from
 * the push URL while `git fetch` stays offline.
 */
export function makeForgeRepo(kind: "github" | "gitlab"): ForgeRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-forge-"));
  const bare = path.join(root, "remote.git");
  const cwd = path.join(root, "work");
  mkdirSync(cwd);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(cwd, "init", "-q", "-b", "main");
  // Persist the same settings so git calls made by the code under test match.
  for (const dir of [bare, cwd]) {
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "gc.auto", "0");
  }
  writeFileSync(path.join(cwd, "a.txt"), "a\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "feature/x");
  writeFileSync(path.join(cwd, "feature.txt"), "x\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "feature");
  git(cwd, "switch", "-q", "main");
  for (const n of [1, 2, 3]) {
    writeFileSync(path.join(cwd, `main-${n}.txt`), `${n}\n`);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `main ${n}`);
  }
  git(cwd, "remote", "add", "origin", bare);
  git(cwd, "push", "-q", "origin", "main", "feature/x");
  const base = git(cwd, "rev-parse", "main");
  // Local main falls back to the shared base, so only the fetch can see 3.
  git(cwd, "switch", "-q", "feature/x");
  git(cwd, "branch", "-q", "-f", "main", "HEAD~1");
  git(cwd, "update-ref", "-d", "refs/remotes/origin/main");
  git(
    cwd,
    "remote",
    "set-url",
    "--push",
    "origin",
    kind === "github" ? "https://github.com/o/r.git" : "https://gitlab.com/group/project.git",
  );
  const head = git(cwd, "rev-parse", "HEAD");
  return {
    root,
    cwd,
    head,
    base,
    subs: { "{{HEAD}}": head, "{{BASE}}": base },
    git: (...args) => git(cwd, ...args),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
