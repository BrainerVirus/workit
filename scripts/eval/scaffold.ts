import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVAL_WORLD_MARKER } from "../../packages/workit-core/src/core/eval-world";
import type { EvalCase } from "./cases";
import { identityAlive, runnerIdentity } from "./tripwire";

/** The marker a world carries: the identity of the runner that made it. */
const RUNNER_MARKER = ".runner";
const WORLD_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Remove bench worlds a dead runner left in the temp dir: real dirs this user
 * owns whose marker names a dead runner, or with no marker and older than 24 h.
 * A symlink is never followed.
 */
export const sweepWorlds = (tmp = os.tmpdir(), now = Date.now()): string[] => {
  const removed: string[] = [];
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith("workit-eval-")) continue;
    const dir = path.join(tmp, name);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || (process.getuid && stat.uid !== process.getuid())) continue;
    let marker: string | null = null;
    try {
      marker = readFileSync(path.join(dir, RUNNER_MARKER), "utf8").trim();
    } catch {
      marker = null;
    }
    const dead = marker ? !identityAlive(marker) : now - stat.mtimeMs > WORLD_MAX_AGE_MS;
    if (!dead) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
};

/** A throwaway world for one run: the repo, an optional worktree, Workit state and config. */
export type World = {
  dir: string;
  repo: string;
  worktree: string | null;
  state: string;
  config: string;
  /** Leads the child's PATH: the fake `ytrack` (FAKE_YTRACK), so no run reaches a real YouTrack. */
  bin: string;
  /** The case gave the world a workspace: the runner sets WORKIT_EVAL_WORLD. */
  workspace?: boolean;
  /** The world's HOME (isolation.ts): empty but for the host's login links. */
  home: string;
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

/**
 * The world's `ytrack`: canned reads (an issue with no comments, no work
 * items, the user `eval`) and every write refused as cancelled (exit 2, sent
 * nothing), so a run never reads or posts to a real YouTrack with the user's
 * login, and reads are the same on every run.
 */
const FAKE_YTRACK = `#!/bin/sh
# workit-eval fake ytrack
refuse() { echo "workit eval: the fake ytrack refuses writes ($*)" >&2; exit 2; }
for arg in "$@"; do
  case "$arg" in -X|--method|-f|-F|--field|--raw-field|--input) refuse "$@" ;; esac
done
case "$1 $2" in
  "work-item list"|"work-item ls") echo '[]' ;;
  "issue view")
    printf '{"idReadable":"%s","summary":"Demo issue","description":null,"state":"Open","url":null,"customFields":[],"comments":[]}\n' "$3" ;;
  "api /users/me"|"api users/me"|"api /api/users/me") echo '{"login":"eval"}' ;;
  "auth status") echo "Logged in to youtrack.invalid as eval (workit eval fake)" ;;
  "version "*|"--version "*) echo "ytrack workit-eval-fake" ;;
  *) refuse "$@" ;;
esac
`;

export const makeWorld = (spec: EvalCase): World => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `workit-eval-${spec.id}-`)));
  const [repo, state, config, bin, home] = ["repo", "state", "config", "bin", "home"].map(
    (name) => {
      const sub = path.join(dir, name);
      mkdirSync(sub);
      return sub;
    },
  ) as [string, string, string, string, string];
  // The runner that made the world: a later start removes it once that runner is dead.
  writeFileSync(path.join(dir, RUNNER_MARKER), runnerIdentity());
  writeFileSync(path.join(bin, "ytrack"), FAKE_YTRACK);
  chmodSync(path.join(bin, "ytrack"), 0o755);
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
    return {
      dir,
      repo,
      worktree: null,
      state,
      config,
      bin,
      workspace: Boolean(scaffold.workspace),
      home,
    };
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
  return {
    dir,
    repo,
    worktree,
    state,
    config,
    bin,
    workspace: Boolean(scaffold.workspace),
    home,
  };
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
