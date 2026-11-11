import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVAL_WORLD_MARKER } from "./world-grants";
import type { EvalCase } from "./cases";

/** A throwaway world for one run: the repo, an optional worktree, Workit state and config. */
export type World = {
  dir: string;
  repo: string;
  worktree: string | null;
  state: string;
  config: string;
  /** The case gave the world a workspace: the runner sets WORKIT_EVAL_WORLD. */
  workspace?: boolean;
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
  if (scaffold.unborn) {
    writeAll(repo, scaffold.dirty);
    writeConfig(dir, config, spec);
    return { dir, repo, worktree: null, state, config, workspace: Boolean(scaffold.workspace) };
  }
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

  writeConfig(dir, config, spec);
  return { dir, repo, worktree, state, config, workspace: Boolean(scaffold.workspace) };
};

const writeConfig = (dir: string, config: string, spec: EvalCase): void => {
  const { allowedBranches: allowed = ["feature/*"], workspace } = spec.scaffold ?? {};
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "custom", allowed, protected: ["main"] } }),
  );
  if (!workspace) return;
  writeFileSync(path.join(dir, EVAL_WORLD_MARKER), "");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "eval", glob: `${dir}/**`, ...workspace }] }),
  );
};

export const promptFor = (spec: EvalCase, world: World): string =>
  spec.prompt.replaceAll("{{root}}", world.repo).replaceAll("{{worktree}}", world.worktree ?? "");
