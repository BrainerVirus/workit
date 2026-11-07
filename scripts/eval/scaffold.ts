import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalCase } from "./cases";

/** A throwaway world for one run: the repo, an optional worktree, Workit state and config. */
export type World = {
  dir: string;
  repo: string;
  worktree: string | null;
  state: string;
  config: string;
};

const git = (cwd: string, ...args: string[]): void => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  if (run.status !== 0) throw new Error(`scaffold: git ${args.join(" ")}: ${run.stderr}`);
};

const writeAll = (root: string, files: Record<string, string> = {}): void => {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
};

export const makeWorld = (spec: EvalCase): World => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `workit-eval-${spec.id}-`)));
  const [repo, state, config] = ["repo", "state", "config"].map((name) => {
    const sub = path.join(dir, name);
    mkdirSync(sub);
    return sub;
  }) as [string, string, string];
  const scaffold = spec.scaffold ?? {};

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "eval@workit.invalid");
  git(repo, "config", "user.name", "Workit Eval");
  git(repo, "config", "commit.gpgsign", "false");
  writeAll(repo, { "README.md": "# demo\n", ...scaffold.files });
  if (scaffold.checks)
    writeAll(repo, {
      ".workit/checks.json": `${JSON.stringify({ checks: scaffold.checks }, null, 2)}\n`,
    });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: init");
  if (scaffold.remote) {
    const origin = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
  }
  if (scaffold.branch && scaffold.branch !== "main")
    git(repo, "checkout", "-q", "-b", scaffold.branch);
  for (const commit of scaffold.commits ?? []) {
    writeAll(repo, commit.files);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", commit.message);
  }
  let worktree: string | null = null;
  if (scaffold.worktree) {
    worktree = path.join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", scaffold.worktree, worktree);
  }
  writeAll(worktree ?? repo, scaffold.dirty);

  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  return { dir, repo, worktree, state, config };
};

export const promptFor = (spec: EvalCase, world: World): string =>
  spec.prompt.replaceAll("{{root}}", world.repo).replaceAll("{{worktree}}", world.worktree ?? "");
