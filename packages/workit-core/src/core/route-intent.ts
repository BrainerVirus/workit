import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { inWorkitWorkspace, rawInvocations } from "../hooks/raw-git";
import type { ShellDialect } from "../hooks/shell-words";
import { validateBranchNameFor, type BranchNamePolicyCheck } from "./branch";

/** A name a shell cannot settle before running (`$X`, `` `cmd` ``): never judged. */
const UNKNOWABLE = /[$`*?[\]{}~]/u;

const SWITCH_CREATE = new Set(["-c", "--create", "-C", "--force-create", "--orphan"]);
const CHECKOUT_CREATE = new Set(["-b", "-B", "--orphan"]);
const WORKTREE_CREATE = new Set(["-b", "-B"]);
/** `git branch` options that list, delete or configure: no branch is created. */
const BRANCH_NO_CREATE = new Set(
  ["-d", "-D", "--delete", "-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current"]
    .concat(["-v", "-vv", "--verbose", "--contains", "--no-contains", "--merged", "--no-merged"])
    .concat(["--points-at", "--sort", "--format", "--column", "--no-column", "-u"])
    .concat(["--set-upstream-to", "--unset-upstream", "--edit-description", "-i", "--ignore-case"]),
);
/** `git branch -m|-c [<old>] <new>`: a rename or copy creates `<new>`. */
const BRANCH_RENAME = new Set(["-m", "-M", "--move", "-c", "-C", "--copy"]);

/** The value of `flag` in `args` (`-c x`, `-cx`, `--create=x`), or null. */
const flagValue = (args: readonly string[], flags: ReadonlySet<string>): string | null => {
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return null;
    if (flags.has(arg)) return args[index + 1] ?? null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0 && flags.has(arg.slice(0, eq))) return arg.slice(eq + 1);
    // An attached short value: `-cchore/x`.
    if (!arg.startsWith("--") && arg.length > 2 && flags.has(arg.slice(0, 2))) return arg.slice(2);
  }
  return null;
};

/** `git worktree add` options that take a value. */
const WORKTREE_VALUES = new Set(["--reason"]);

/**
 * `git worktree add [-b|-B <b>] <path> [<commit-ish>]`: the -b name, or, with
 * only a path (no -b, -B, --detach or commit-ish), the branch git names after
 * the path's last component.
 */
const worktreeTarget = (args: readonly string[]): string | null => {
  const named = flagValue(args, WORKTREE_CREATE);
  if (named !== null) return named;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--detach" || arg === "-d") return null;
    if (WORKTREE_VALUES.has(arg)) index++;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (positionals.length !== 1) return null;
  const base = positionals[0].split(/[\\/]/u).findLast(Boolean) ?? "";
  return base && base !== "." && base !== ".." ? base : null;
};

/** The branch `git branch …` creates (plain, rename or copy), or null. */
const branchCommandTarget = (args: readonly string[]): string | null => {
  let rename = false;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    const flag = arg.split("=", 1)[0];
    if (BRANCH_NO_CREATE.has(flag)) return null;
    if (BRANCH_RENAME.has(flag)) rename = true;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (positionals.length < 1 || positionals.length > 2) return null;
  return rename ? (positionals.at(-1) ?? null) : positionals[0];
};

/**
 * The branch one git invocation creates: `switch -c|-C|--create <b>`,
 * `checkout -b|-B <b>`, `branch [-m|-c] <b> [start]` and `worktree add -b|-B
 * <b>`, wherever the option stands. `args` start at the subcommand (after
 * git's global options). Null when it creates none.
 */
export const gitBranchCreation = (args: readonly string[]): string | null => {
  const [sub, second] = args;
  const target =
    sub === "switch"
      ? flagValue(args, SWITCH_CREATE)
      : sub === "checkout"
        ? flagValue(args, CHECKOUT_CREATE)
        : sub === "branch"
          ? branchCommandTarget(args)
          : sub === "worktree" && second === "add"
            ? worktreeTarget(args.slice(1))
            : null;
  return target && !target.startsWith("-") && !UNKNOWABLE.test(target) ? target : null;
};

export type ShellBranchTarget = {
  branch: string;
  /** The directory git runs in, relative to the hook's cwd; undefined when unknowable. */
  dir: string | null | undefined;
};

/**
 * Every branch a shell command creates, through the raw-git tokenizer: `&&`,
 * `;` and `|` chains, `cd`/`pushd` and `git -C`, env prefixes and wrappers,
 * quoted names and `bash -c` scripts.
 */
export const shellBranchTargets = (
  command: string,
  dialect: ShellDialect = "posix",
): ShellBranchTarget[] => {
  if (!/\bgit\b/u.test(command)) return [];
  const found: ShellBranchTarget[] = [];
  for (const invocation of rawInvocations(command, dialect)) {
    if (invocation.tool !== "git") continue;
    const branch = gitBranchCreation(invocation.args);
    if (branch) found.push({ branch, dir: invocation.dir });
  }
  return found;
};

/** The first branch a shell command creates, or null. */
export const shellBranchTarget = (command: string): string | null =>
  shellBranchTargets(command)[0]?.branch ?? null;

/** The branch already exists in `dir`: resetting or checking it out is not a new name. */
const localBranchExists = (dir: string, branch: string): boolean =>
  spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: dir,
    stdio: "ignore",
    timeout: 5_000,
  }).status === 0;

/**
 * The branch policy verdict for every new branch a shell command creates,
 * each checked in the directory git runs in (a linked worktree resolves to
 * its main checkout's workspace). A command that runs in the hook's cwd is
 * judged there. One that changes directory is judged only when that
 * directory is known, already exists and is in a Workit workspace: a scratch
 * repository (`cd "$(mktemp -d)"`, `git init x && cd x`, a fresh clone) is
 * not the cwd workspace's business. A name that already exists locally is
 * skipped (`git branch -f legacy HEAD`). Null when no new branch is judged;
 * the first violation otherwise.
 */
export const shellBranchPolicyViolation = (
  root: string,
  command: string,
  dialect: ShellDialect = "posix",
): BranchNamePolicyCheck | null => {
  let judged = false;
  for (const target of shellBranchTargets(command, dialect)) {
    if (target.dir === undefined) continue;
    const dir = target.dir === null ? root : path.resolve(root, target.dir);
    if (target.dir !== null && (!existsSync(dir) || !inWorkitWorkspace(dir))) continue;
    if (localBranchExists(dir, target.branch)) continue;
    judged = true;
    const check = validateBranchNameFor(dir, target.branch);
    if (!check.ok) return check;
  }
  return judged ? { ok: true } : null;
};
