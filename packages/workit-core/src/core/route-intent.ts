import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  expandGitAliases,
  inWorkitWorkspace,
  pushAction,
  rawInvocations,
  type RawInvocation,
} from "../hooks/raw-git";
import type { ShellDialect } from "../hooks/shell-words";
import { validateBranchNameFor, type BranchNamePolicyCheck } from "./branch";

/** A name a shell cannot settle before running (`$X`, `` `cmd` ``): never judged. */
const UNKNOWABLE = /[$`*?[\]{}~]/u;

const SWITCH_CREATE = new Set(["-c", "--create", "-C", "--force-create", "--orphan"]);
const CHECKOUT_CREATE = new Set(["-b", "-B", "--orphan"]);
const WORKTREE_CREATE = new Set(["-b", "-B"]);
const SUBTREE_CREATE = new Set(["-b", "--branch"]);
/** `git branch` options that list, delete or configure: no branch is created. */
const BRANCH_NO_CREATE = new Set(
  ["-d", "-D", "--delete", "-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current"]
    .concat(["-v", "-vv", "--verbose", "--contains", "--no-contains", "--merged", "--no-merged"])
    .concat(["--points-at", "--sort", "--format", "--column", "--no-column", "-u"])
    .concat(["--set-upstream-to", "--unset-upstream", "--edit-description", "-i", "--ignore-case"]),
);
/** `git branch -m|-c [<old>] <new>`: a rename or copy creates `<new>`. */
const BRANCH_RENAME = new Set(["-m", "-M", "--move", "-c", "-C", "--copy"]);

/** `--name` matches a long option in `flags`, whole or by git's unambiguous-prefix rule (`--cre`). */
const longOption = (name: string, flags: ReadonlySet<string>): boolean =>
  flags.has(name) ||
  (name.length >= 3 && [...flags].some((flag) => flag.startsWith("--") && flag.startsWith(name)));

/** The short options of `flags` (`-c` → `c`). */
const shortsOf = (flags: ReadonlySet<string>): string =>
  [...flags]
    .filter((flag) => /^-[^-]$/u.test(flag))
    .join("")
    .replaceAll("-", "");

/**
 * The value of `flag` in `args`: `-c x`, `-cx`, a short cluster (`-fc x`),
 * `--create=x`, `--create x` or an abbreviation (`--cre x`). Null when absent.
 */
const flagValue = (args: readonly string[], flags: ReadonlySet<string>): string | null => {
  const shorts = shortsOf(flags);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (!longOption(eq > 0 ? arg.slice(0, eq) : arg, flags)) continue;
      return eq > 0 ? arg.slice(eq + 1) : (args[index + 1] ?? null);
    }
    if (!arg.startsWith("-") || arg.length < 2) continue;
    // A cluster of short switches; the creating one takes the rest or the next word.
    for (let at = 1; at < arg.length; at++)
      if (shorts.includes(arg[at]))
        return at + 1 < arg.length ? arg.slice(at + 1) : (args[index + 1] ?? null);
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
    if (arg.startsWith("--")) {
      const flag = arg.split("=", 1)[0];
      if (longOption(flag, BRANCH_NO_CREATE)) return null;
      if (longOption(flag, BRANCH_RENAME)) rename = true;
    } else if (arg.startsWith("-") && arg.length > 1) {
      // A short cluster: `-fm`, `-vv`, `-dr`.
      const shorts = arg.slice(1).split("");
      if (shorts.some((short) => BRANCH_NO_CREATE.has(`-${short}`))) return null;
      if (shorts.some((short) => BRANCH_RENAME.has(`-${short}`))) rename = true;
    } else positionals.push(arg);
  }
  if (positionals.length < 1 || positionals.length > 2) return null;
  return rename ? (positionals.at(-1) ?? null) : positionals[0];
};

/** Positional words after `skip` leading words, past options; `values` take the next word. */
const positionalsOf = (
  args: readonly string[],
  skip: number,
  values: ReadonlySet<string> = new Set(),
): string[] => {
  const found: string[] = [];
  for (let index = skip; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return [...found, ...args.slice(index + 1)];
    if (values.has(arg)) index++;
    else if (!arg.startsWith("-") || arg === "-") found.push(arg);
  }
  return found;
};

const localHead = (ref: string): string | null =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;

/** `git update-ref refs/heads/<b> <sha>` and `--stdin` `create|update refs/heads/<b>` lines. */
const updateRefTargets = (args: readonly string[], stdin: string | undefined): string[] => {
  if (args.some((arg) => arg === "-d" || arg === "--delete")) return [];
  if (args.includes("--stdin"))
    return (stdin ?? "")
      .split(/[\n\0]/u)
      .map((line) => /^\s*(?:create|update)\s+(\S+)/u.exec(line)?.[1] ?? "")
      .map(localHead)
      .filter((name): name is string => name !== null);
  const [ref] = positionalsOf(args, 1, new Set(["-m"]));
  const name = ref ? localHead(ref) : null;
  return name ? [name] : [];
};

/** `git symbolic-ref HEAD refs/heads/<b>`: the next commit creates `<b>`. */
const symbolicRefTarget = (args: readonly string[]): string | null => {
  if (args.some((arg) => arg === "-d" || arg === "--delete")) return null;
  const [, ref] = positionalsOf(args, 1, new Set(["-m"]));
  return ref ? localHead(ref) : null;
};

/** git fetch/pull options that take a value. */
const FETCH_VALUES = new Set(
  ["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--refmap", "-j", "--jobs"]
    .concat(["--upload-pack", "-o", "--server-option", "--negotiation-tip", "--filter"])
    .concat(["--recurse-submodules-default", "--submodule-prefix", "-s", "--strategy", "-X"])
    .concat(["--strategy-option"]),
);

/**
 * `git fetch|pull <remote> <src>:<dst>` writes the local branch `<dst>`
 * (`refs/heads/<dst>` or a bare name); `--stdin` reads the refspecs. A
 * glob destination mirrors names the remote already has.
 */
const fetchTargets = (args: readonly string[], stdin: string | undefined): string[] => {
  if (args.includes("--all") || args.includes("--multiple")) return [];
  const specs = args.includes("--stdin")
    ? (stdin ?? "").split(/\s+/u).filter(Boolean)
    : positionalsOf(args, 1, FETCH_VALUES).slice(1);
  const names: string[] = [];
  for (const raw of specs) {
    const colon = raw.indexOf(":");
    const destination = colon >= 0 ? raw.slice(colon + 1) : "";
    if (!destination || destination.includes("*")) continue;
    const name = destination.startsWith("refs/") ? localHead(destination) : destination;
    if (name) names.push(name);
  }
  return names;
};

/** `git push . <src>:<dst>` writes the local branch `<dst>`. */
const localPushTargets = (args: string[]): string[] => {
  const action = pushAction(args);
  if (action?.kind !== "push" || action.remote !== "." || action.deletes) return [];
  return action.targets.filter((name): name is string => name !== null);
};

/**
 * The branches one git invocation creates: `switch -c|-C|--create <b>`,
 * `checkout -b|-B <b>`, `branch [-m|-c] <b> [start]`, `worktree add -b|-B
 * <b>`, `stash branch <b>`, `update-ref refs/heads/<b>`, `symbolic-ref HEAD
 * refs/heads/<b>`, `fetch|pull <remote> <src>:<b>`, `push . <src>:<b>` and
 * `subtree split -b <b>`, wherever the option stands. `args` start at the
 * subcommand (after git's global options). Names a shell settles only when
 * it runs (`$X`) are left out.
 */
export const gitBranchCreations = (args: string[], stdin?: string): string[] => {
  const [sub, second] = args;
  const targets: Array<string | null> =
    sub === "switch"
      ? [flagValue(args, SWITCH_CREATE)]
      : sub === "checkout"
        ? [flagValue(args, CHECKOUT_CREATE)]
        : sub === "branch"
          ? [branchCommandTarget(args)]
          : sub === "worktree" && second === "add"
            ? [worktreeTarget(args.slice(1))]
            : sub === "stash" && second === "branch"
              ? positionalsOf(args, 2).slice(0, 1)
              : sub === "update-ref"
                ? updateRefTargets(args, stdin)
                : sub === "symbolic-ref"
                  ? [symbolicRefTarget(args)]
                  : sub === "fetch" || sub === "pull"
                    ? fetchTargets(args, stdin)
                    : sub === "push"
                      ? localPushTargets(args)
                      : sub === "subtree" && second === "split"
                        ? [flagValue(args.slice(1), SUBTREE_CREATE)]
                        : [];
  return targets.filter(
    (target): target is string =>
      target !== null && target !== "" && !target.startsWith("-") && !UNKNOWABLE.test(target),
  );
};

export type ShellBranchTarget = {
  branch: string;
  /** The directory git runs in, relative to the hook's cwd; undefined when unknowable. */
  dir: string | null | undefined;
};

const targetsOf = (invocations: readonly RawInvocation[]): ShellBranchTarget[] =>
  invocations.flatMap((invocation) =>
    invocation.tool === "git"
      ? gitBranchCreations(invocation.args, invocation.stdin).map((branch) => ({
          branch,
          dir: invocation.dir,
        }))
      : [],
  );

/**
 * Every branch a shell command creates, through the raw-git tokenizer: `&&`,
 * `;` and `|` chains, `cd`/`pushd` and `git -C`, env prefixes and wrappers,
 * quoted names, compound commands and nested scripts (git aliases need the
 * repository: see shellBranchPolicyViolation).
 */
export const shellBranchTargets = (
  command: string,
  dialect: ShellDialect = "posix",
): ShellBranchTarget[] => targetsOf(rawInvocations(command, dialect));

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

/** The directory a command judged from `root` runs git in, or null when not this policy's business. */
const judgedDir = (root: string, dir: string | null | undefined): string | null => {
  if (dir === undefined) return null;
  if (dir === null) return root;
  const resolved = path.resolve(root, dir);
  return existsSync(resolved) && inWorkitWorkspace(resolved) ? resolved : null;
};

/**
 * The branch policy verdict for every new branch a shell command creates,
 * each checked in the directory git runs in (a linked worktree resolves to
 * its main checkout's workspace). A command that runs in the hook's cwd is
 * judged there. One that changes directory is judged only when that
 * directory is known, already exists and is in a Workit workspace: a scratch
 * repository (`cd "$(mktemp -d)"`, `git init x && cd x`, a fresh clone) is
 * not the cwd workspace's business. A git alias is resolved there first. A
 * name that already exists locally is skipped (`git branch -f legacy HEAD`).
 * Null when no new branch is judged; the first violation otherwise.
 */
export const shellBranchPolicyViolation = (
  root: string,
  command: string,
  dialect: ShellDialect = "posix",
): BranchNamePolicyCheck | null => {
  let judged = false;
  const cache = new Map();
  for (const raw of rawInvocations(command, dialect)) {
    if (raw.tool !== "git" || judgedDir(root, raw.dir) === null) continue;
    for (const target of targetsOf(expandGitAliases(root, raw, cache))) {
      const dir = judgedDir(root, target.dir);
      if (dir === null || localBranchExists(dir, target.branch)) continue;
      judged = true;
      const check = validateBranchNameFor(dir, target.branch);
      if (!check.ok) return check;
    }
  }
  return judged ? { ok: true } : null;
};
