// `workit git branch|commit|push` (design §2.1 S11): policy-checked local git
// effects plus an observed, verified push. The CLI verb only parses flags and
// resolves the forge identity; every rule lives here.
//
// - branch: the name must pass the workspace branch policy (protected names
//   and allowed patterns, core/branch.ts). The base defaults to the policy's
//   default target and is taken from the freshly fetched remote branch; a
//   local, unprotected, non-default base is a stack parent and is used as is.
//   Dirt outside docs/ and untracked files needs --carry.
// - commit: never on a protected branch; the subject must pass the workspace
//   commit convention (auto = the flavor the history uses). Only the index,
//   the named paths (`--only` semantics) or, with --all, everything is
//   committed: unrelated dirt is never swept in implicitly. The acting session
//   goes into a `Workit-Session:` trailer and a `commit.recorded` ledger row,
//   so a verdict from the same session reads as the author's (D18).
// - push: never to a protected branch, an exact SHA (a commit that lands while
//   pushing is not pushed by accident), force only as --force-with-lease with
//   the tip workit last recorded, and success only when the remote tip
//   observed afterwards equals the local SHA (`push.verified` row).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyBranchDirt,
  isProtectedTarget,
  resolveCommitPolicyFor,
  validateBranchNameFor,
  validateCommitMessageFor,
} from "../core/branch";
import { detectCommitFlavor, matchCommitFlavor } from "../core/commit-flavors";
import { pushTargetIsStable } from "../core/pr-create";
import { recordBranchBase, trackBranchName } from "../core/release-tracks";
import { vcsConfig, type ResolvedReleaseTrack } from "../core/vcs-config";
import { redactText } from "../forge/redact";
import { failure, success, type ForgeResult } from "../forge/types";
import { appendObserved, readLedger, type LedgerActor } from "../ledger";
import {
  GIT_TIMEOUTS,
  currentBranch,
  fetchRefs,
  gitNetwork,
  headSha,
  parseRemoteUrl,
  pushRemoteName,
  pushUrl,
  redactRemote,
  remoteNames,
  remoteRefTip,
  resolveRef,
} from "./rev";

/** Commits run the repository's hooks (lint, tests), so they get a long bound. */
const COMMIT_TIMEOUT_MS = 10 * 60_000;
const PUSH_TIMEOUT_MS = 120_000;

type Run = {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

const git = (
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Run => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? GIT_TIMEOUTS.local,
    killSignal: "SIGKILL",
    windowsHide: true,
    ...(options.input === undefined
      ? { stdio: ["ignore", "pipe", "pipe"] as const }
      : { input: options.input, stdio: ["pipe", "pipe", "pipe"] as const }),
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** The last meaningful lines of git's stderr, redacted, for an error message. */
const gitError = (run: { stderr: string; stdout?: string }, max = 3): string => {
  const lines = redactText(`${run.stderr}\n${run.stdout ?? ""}`)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("hint:"));
  return lines.slice(-max).join(" / ").slice(0, 400) || "git failed";
};

/** Past this many lines, hook output keeps its head and tail. */
const OUTPUT_LINES = 200;
/** A longer output line (a minified bundle, a JSON blob) is cut here. */
const OUTPUT_LINE_CHARS = 1000;

/**
 * Everything git and its hooks printed, redacted and without `hint:` lines, so
 * a failing lint hook's errors reach the agent. Long output keeps the first
 * and last OUTPUT_LINES / 2 lines.
 */
const gitOutput = (run: { stderr: string; stdout?: string }): string => {
  const lines = redactText(`${run.stderr}\n${run.stdout ?? ""}`)
    .split(/\r?\n/u)
    .map((value) => value.trimEnd())
    .filter((value) => value.trim() && !value.trimStart().startsWith("hint:"))
    .map((value) =>
      value.length > OUTPUT_LINE_CHARS ? `${value.slice(0, OUTPUT_LINE_CHARS)}…` : value,
    );
  if (!lines.length) return "git failed";
  if (lines.length <= OUTPUT_LINES) return lines.join("\n");
  const half = OUTPUT_LINES / 2;
  return [
    ...lines.slice(0, half),
    `… ${lines.length - OUTPUT_LINES} lines omitted …`,
    ...lines.slice(-half),
  ].join("\n");
};

type Operation = "rebase" | "am" | "merge" | "cherry-pick" | "revert";

type InProgress = {
  operation: Operation;
  /**
   * A commit is the legitimate next step: an interactive rebase stopped at an
   * `edit`, or a revert or merge without conflicts (`--no-commit`).
   */
  commitAllowed: boolean;
  /** The branch being rebased (HEAD is detached meanwhile). */
  branch: string | null;
};

/** The multi-step git operation the checkout is in the middle of, if any. */
function operationInProgress(cwd: string): InProgress | null {
  const markers: [string, Operation][] = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  const run = git(cwd, ["rev-parse", ...markers.flatMap(([name]) => ["--git-path", name])]);
  if (!run.ok) return null;
  const found = run.stdout.split("\n").map((line) => path.resolve(cwd, line.trim()));
  const conflicted = () => git(cwd, ["ls-files", "-u"]).stdout.trim() !== "";
  for (const [index, [, operation]] of markers.entries()) {
    const marker = found[index];
    if (!marker || !existsSync(marker)) continue;
    // `git am` also uses rebase-apply; its `applying` file tells them apart.
    if (index === 1 && existsSync(path.join(marker, "applying")))
      return { operation: "am", commitAllowed: false, branch: null };
    // An `edit` stop leaves rebase-merge/amend; the rebased branch is head-name.
    if (index === 0 && existsSync(path.join(marker, "amend")) && !conflicted()) {
      let headName = "";
      try {
        headName = readFileSync(path.join(marker, "head-name"), "utf8").trim();
      } catch {
        // No head-name: a rebase of a detached HEAD; there is no branch to commit for.
      }
      const branch = headName.startsWith("refs/heads/")
        ? headName.slice("refs/heads/".length)
        : null;
      return { operation, commitAllowed: branch !== null, branch };
    }
    if ((operation === "revert" || operation === "merge") && !conflicted())
      return { operation, commitAllowed: true, branch: null };
    return { operation, commitAllowed: false, branch: null };
  }
  return null;
}

/** A refusal that names the operation in progress and how to finish or leave it. */
function inProgressFailure<T>(operation: Operation, verb: string): ForgeResult<T> {
  const command = operation === "am" ? "git am" : `git ${operation}`;
  return failure(
    "blocked",
    `${operation.replace("-", "_")}_in_progress: a ${operation === "am" ? "git am" : operation} is in progress; finish or abort it before workit can ${verb}`,
    `resolve the conflicts, git add <files>, then ${command} --continue  # or ${command} --abort to return to where you started`,
  );
}

const validRefName = (cwd: string, name: string): boolean =>
  !name.startsWith("-") && git(cwd, ["check-ref-format", "--branch", name]).ok;

/** Porcelain v1 entries (`XY path`), NUL-separated so any file name survives. */
function dirtEntries(cwd: string): string[] {
  const run = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!run.ok) return [];
  const parts = run.stdout.split("\0");
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    out.push(entry);
    // A rename/copy carries its source path in the next field.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return out;
}

const nulList = (text: string): string[] => text.split("\0").filter(Boolean);

// ---------------------------------------------------------------------------
// branch

export type BranchOutcome = {
  branch: string;
  previous: string | null;
  base: string;
  /** The ref the branch was created from (refs/remotes/origin/main, refs/heads/feature/a, a sha). */
  baseRef: string;
  baseSha: string;
  /** Uncommitted changes came along to the new branch. */
  carried: boolean;
  /** Fallbacks taken (fetch failed, base used from the local copy). */
  notes: string[];
  /** The release track the base and name came from; null without tracks. */
  releaseTrack: ResolvedReleaseTrack | null;
};

export type BranchInput = {
  /** An explicit branch name; else `kind` + `slug` through the track's naming. */
  name?: string;
  kind?: "feature" | "bugfix" | "hotfix";
  slug?: string;
  base?: string | null;
  carry?: boolean;
  /** An explicit release track (`--track`). */
  track?: string | null;
};

export function gitBranch(cwd: string, input: BranchInput): ForgeResult<BranchOutcome> {
  if (!headSha(cwd) && currentBranch(cwd) === null)
    return failure("invalid_input", "not inside a git repository with a commit");
  const progress = operationInProgress(cwd);
  if (progress) return inProgressFailure(progress.operation, "create a branch");
  // One resolution: the default target, the base for new branches and the
  // release track (core/release-tracks.ts) all come from vcsConfig. With
  // --base the track is the base's line (it decides the --kind naming);
  // otherwise the checkout's.
  const explicitBase = input.base?.trim() || null;
  const resolved = vcsConfig("resolve", cwd, {
    track: input.track ?? null,
    ...(explicitBase ? { branch: explicitBase } : {}),
  });
  const releaseTrack: ResolvedReleaseTrack | null =
    resolved.ok === false ? null : (resolved.releaseTrack ?? null);
  // An undetermined line blocks whenever the track would decide something:
  // the base (no --base) or the --kind/--slug name.
  if (releaseTrack?.blocking && (!explicitBase || input.name === undefined))
    return failure(
      "blocked",
      String(releaseTrack.blocking),
      "workit git branch … --track <name>  # or --base <branch>",
    );
  const name = (
    input.name ??
    (input.kind && input.slug
      ? (trackBranchName(releaseTrack?.track ?? null, input.kind, input.slug) ??
        `${input.kind}/${input.slug}`)
      : "")
  ).trim();
  if (!name) return failure("invalid_input", "missing branch name");
  if (!validRefName(cwd, name))
    return failure("invalid_input", `invalid branch name ${JSON.stringify(name)}`);
  const policy = validateBranchNameFor(cwd, name);
  if (!policy.ok) return failure("blocked", policy.error, policy.correction);
  if (resolveRef(cwd, `refs/heads/${name}`))
    return failure("failed", `branch_exists: ${name} already exists`, `git switch ${name}`);

  let base = explicitBase;
  let defaultTarget: string | null = null;
  let defaultBase: string | null = null;
  // An explicit --track that does not resolve is never ignored, even with --base.
  if (resolved.ok === false && (!base || input.track))
    return failure(
      "blocked",
      String(resolved.error),
      "fix ~/.config/workit/vcs.json or pass --base <branch>",
    );
  if (resolved.ok !== false) {
    defaultTarget = String(resolved.defaultTargetBranch ?? "") || null;
    defaultBase = String(resolved.baseBranch ?? "") || defaultTarget;
  }
  base ??= defaultBase;
  if (!base)
    return failure("invalid_input", "no default target branch is configured; pass --base <branch>");
  if (base.startsWith("-")) return failure("invalid_input", "--base must not start with -");

  const notes: string[] = [...(releaseTrack?.warnings ?? [])];
  const remotes = remoteNames(cwd);
  const remote = remotes.includes("origin") ? "origin" : pushRemoteName(cwd);
  const localTip = resolveRef(cwd, `refs/heads/${base}`);
  // A local, unprotected branch that is not the default target is a stack
  // parent: its local tip is the truth (it may not be pushed yet).
  const stackParent =
    localTip !== null &&
    base !== defaultTarget &&
    base !== defaultBase &&
    !isProtectedTarget(cwd, base);
  let baseRef: string | null = null;
  if (stackParent) baseRef = `refs/heads/${base}`;
  else if (remote && validRefName(cwd, base)) {
    const tracking = `refs/remotes/${remote}/${base}`;
    const fetched = fetchRefs(cwd, remote, [`+refs/heads/${base}:${tracking}`]);
    if (fetched.ok && resolveRef(cwd, tracking)) baseRef = tracking;
    else if (resolveRef(cwd, tracking)) {
      baseRef = tracking;
      notes.push(
        `fetch of ${remote}/${base} failed; branched from the last fetched ${remote}/${base}`,
      );
    } else if (localTip) {
      baseRef = `refs/heads/${base}`;
      notes.push(`${remote}/${base} is not available; branched from local ${base}`);
    }
  } else if (localTip) baseRef = `refs/heads/${base}`;
  if (!baseRef && git(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`]).ok) baseRef = base;
  const baseSha = baseRef
    ? git(cwd, ["rev-parse", "--verify", "-q", `${baseRef}^{commit}`]).stdout.trim()
    : "";
  if (!baseRef || !baseSha)
    return failure(
      "not_found",
      `base ${base} does not resolve (no ${remote ?? "remote"}/${base}, no local ${base})`,
      `git fetch ${remote ?? "origin"} ${base}  # or pass --base <ref>`,
    );

  const dirt = classifyBranchDirt(cwd);
  if (dirt === "stash-required" && !input.carry)
    return failure(
      "blocked",
      "dirty_worktree: tracked changes outside docs/ would ride along to the new branch",
      `commit them first (workit git commit -m … -- <paths>), or pass --carry to bring them along`,
    );
  const previous = currentBranch(cwd);
  const switched = git(cwd, ["switch", "--no-track", "-c", name, baseSha]);
  if (!switched.ok) return failure("failed", `git switch -c ${name} failed: ${gitError(switched)}`);
  // The cheapest track signal later (release-tracks.ts): where this branch began.
  recordBranchBase(cwd, name, base);
  return success({
    branch: name,
    previous,
    base,
    baseRef,
    baseSha,
    carried: dirt !== "clean",
    notes,
    releaseTrack,
  });
}

// ---------------------------------------------------------------------------
// commit

export type CommitOutcome = {
  sha: string;
  branch: string;
  message: string;
  files: string[];
  /** Changes left uncommitted (not selected). */
  leftDirty: number;
  session: string | null;
  /** With --amend: the commit this one replaced. */
  amended: string | null;
  /** Follow-ups the agent should know (an amended commit that was already pushed). */
  notes: string[];
  /** The ledger row id, or why it could not be written (the commit stands). */
  recorded: { id: string } | { error: string };
};

/** The commit convention check: the configured preset, or the history's flavor for `auto`. */
export function lintCommitMessage(
  cwd: string,
  message: string,
): { ok: true } | { ok: false; error: string; correction: string } {
  const check = validateCommitMessageFor(cwd, message);
  if (!check.ok) return { ok: false, error: check.error, correction: check.correction };
  let preset: string;
  try {
    preset = resolveCommitPolicyFor(cwd).preset;
  } catch {
    return { ok: true };
  }
  if (preset !== "auto") return { ok: true };
  const log = git(cwd, ["log", "-n", "50", "--no-merges", "--format=%s"]);
  const subjects = log.ok ? log.stdout.split("\n").filter(Boolean) : [];
  const detected = detectCommitFlavor(subjects).flavor;
  if (!detected || matchCommitFlavor(message, detected)) return { ok: true };
  const subject = message.split("\n", 1)[0] ?? "";
  return {
    ok: false,
    error: `commit_style: commit subject ${JSON.stringify(subject)} does not follow the ${detected} style this repository uses (commitPolicy auto)`,
    correction: `use a ${detected} commit subject`,
  };
}

const SESSION_SAFE = /^[\w.:@/+-]{1,128}$/u;

// Fixed trailer syntax, whatever the user's trailer.* config says.
const TRAILER_CONFIG = ["-c", "trailer.separators=:", "-c", "trailer.where=end"];

/** The trailers (`Key: value`) of a commit message. */
function messageTrailers(cwd: string, message: string): string[] {
  const run = git(cwd, [...TRAILER_CONFIG, "interpret-trailers", "--parse", "--no-divider"], {
    input: `${message}\n`,
  });
  return run.ok ? run.stdout.split("\n").filter((line) => line.trim()) : [];
}

/**
 * The message with `trailers` appended, keeping every existing trailer and
 * never repeating an identical one (an amend of a commit this session already
 * made). `--no-divider`: a `---` line in the body is text, not a patch start.
 */
function withTrailers(cwd: string, message: string, trailers: readonly string[]): string {
  if (!trailers.length) return message;
  const run = git(
    cwd,
    [
      ...TRAILER_CONFIG,
      "interpret-trailers",
      "--no-divider",
      "--if-exists",
      "addIfDifferent",
      ...trailers.flatMap((trailer) => ["--trailer", trailer]),
    ],
    { input: `${message}\n` },
  );
  return run.ok ? run.stdout.trim() : `${message}\n\n${trailers.join("\n")}`;
}

/** Short names (`main`, `develop`) of the refs that contain `sha`, local or remote. */
function branchesContaining(cwd: string, sha: string): Set<string> {
  const run = git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    sha,
    "refs/heads",
    "refs/remotes",
  ]);
  const names = new Set<string>();
  for (const ref of run.ok ? run.stdout.split("\n") : []) {
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.split("/").slice(3).join("/");
      if (name && name !== "HEAD") names.add(name);
    }
  }
  return names;
}

/**
 * The shared branch (protected, or the default target or base) that already
 * contains `sha`: amending it would rewrite a commit that is not this
 * branch's own. Null when `sha` is the branch's own.
 */
function sharedBranchContaining(cwd: string, sha: string, branch: string): string | null {
  const resolved = vcsConfig("resolve", cwd);
  const defaults = new Set(
    resolved.ok === false
      ? []
      : [resolved.defaultTargetBranch, resolved.baseBranch]
          .map((value) => String(value ?? ""))
          .filter(Boolean),
  );
  for (const name of branchesContaining(cwd, sha))
    if (name !== branch && (defaults.has(name) || isProtectedTarget(cwd, name))) return name;
  return null;
}

const nothingToCommit = (what: string) =>
  failure<CommitOutcome>(
    "failed",
    `nothing_to_commit: ${what}`,
    "workit git commit --allow-empty -m '<msg>'  # only to record an empty commit on purpose",
  );

export function gitCommit(
  cwd: string,
  input: {
    /** The new message; with `amend` and no message the amended commit's is kept. */
    message?: string | null;
    all?: boolean;
    paths?: readonly string[];
    /** Replace the branch's last commit (`git commit --amend`). */
    amend?: boolean;
    /** Record a commit even when it changes no file. */
    allowEmpty?: boolean;
    actor: LedgerActor;
    env?: NodeJS.ProcessEnv;
  },
): ForgeResult<CommitOutcome> {
  const given = input.message?.trim() ?? "";
  if (!given && !input.amend)
    return failure("invalid_input", "a commit message is required (-m <msg> or -F <file>)");
  const paths = input.paths ?? [];
  if (input.all && paths.length) return failure("invalid_input", "pass --all or paths, not both");
  const progress = operationInProgress(cwd);
  if (progress && !progress.commitAllowed) return inProgressFailure(progress.operation, "commit");
  const branch = progress?.branch ?? currentBranch(cwd);
  if (!branch)
    return failure(
      "invalid_input",
      "HEAD is detached; commit on a branch (workit git branch <name>)",
    );
  if (isProtectedTarget(cwd, branch))
    return failure(
      "blocked",
      `protected_branch: ${branch} is protected by the workspace branch policy; workit never commits to it`,
      "workit git branch <feature/name>  # then commit there",
    );
  const previous = input.amend ? headSha(cwd) : null;
  if (input.amend && !previous)
    return failure("invalid_input", `nothing to amend: ${branch} has no commit yet`);
  if (previous) {
    const shared = sharedBranchContaining(cwd, previous, branch);
    if (shared)
      return failure(
        "blocked",
        `amend_shared_commit: ${previous.slice(0, 12)} is already on ${shared}, so it is not ${branch}'s own commit; workit never rewrites it`,
        "workit git commit -m '<msg>' -- <paths>  # add a new commit instead",
      );
  }
  let message = given;
  let carried: string[] = [];
  if (given) {
    const lint = lintCommitMessage(cwd, given);
    if (!lint.ok) return failure("blocked", lint.error, lint.correction);
  }
  if (previous) {
    const kept = git(cwd, ["log", "-1", "--format=%B", previous]);
    if (!kept.ok)
      return failure("failed", `could not read the message of ${branch}: ${gitError(kept)}`);
    // --no-edit keeps the message whole; a new message carries the old trailers over.
    if (given) carried = messageTrailers(cwd, kept.stdout.trim());
    else message = kept.stdout.trim();
  }
  const session = input.actor.session;
  if (session && !SESSION_SAFE.test(session))
    return failure(
      "invalid_input",
      "WORKIT_SESSION_ID must be 1-128 characters of [A-Za-z0-9_.:@/+-]",
    );
  // A commit that only rewords (amend) or is empty on purpose needs no change.
  const changeRequired = !input.amend && !input.allowEmpty;

  // Amending an empty commit (a CI retrigger) keeps it empty without --allow-empty.
  const emptyAmend =
    previous !== null &&
    git(cwd, ["rev-parse", "--verify", "-q", `${previous}^{tree}`]).stdout.trim() ===
      git(cwd, ["rev-parse", "--verify", "-q", `${previous}~1^{tree}`]).stdout.trim();
  const args = ["commit", "--no-edit"];
  if (input.amend) args.push("--amend");
  if (input.allowEmpty || emptyAmend) args.push("--allow-empty");
  args.push(
    "-m",
    withTrailers(cwd, message, [...carried, ...(session ? [`Workit-Session: ${session}`] : [])]),
  );
  if (paths.length) {
    if (paths.some((value) => value.startsWith("-") || !value.trim()))
      return failure("invalid_input", "paths must not be empty or start with -");
    // A path already removed from disk and index (`git rm`) has nothing to
    // add, and `git add` would fail on it; the commit below still records it.
    const tracked = new Set(nulList(git(cwd, ["ls-files", "-z", "--", ...paths]).stdout));
    const addable = paths.filter(
      (value) =>
        existsSync(path.resolve(cwd, value)) ||
        [...tracked].some((file) => file === value || file.startsWith(`${value}/`)),
    );
    if (addable.length) {
      const added = git(cwd, ["add", "-A", "--", ...addable]);
      if (!added.ok) return failure("failed", `git add failed: ${gitError(added)}`);
    }
    if (changeRequired && git(cwd, ["diff", "--cached", "--quiet", "HEAD", "--", ...paths]).ok)
      return nothingToCommit(`${paths.join(", ")} has no change to commit`);
    args.push("--", ...paths);
  } else if (input.all) {
    const added = git(cwd, ["add", "-A"]);
    if (!added.ok) return failure("failed", `git add failed: ${gitError(added)}`);
    if (changeRequired && git(cwd, ["diff", "--cached", "--quiet"]).ok)
      return nothingToCommit("the working tree is clean");
  } else if (changeRequired) {
    const staged = git(cwd, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.ok && !staged.stdout.replaceAll("\0", "")) {
      const dirt = dirtEntries(cwd);
      if (!dirt.length) return nothingToCommit("the working tree is clean");
      return failure(
        "blocked",
        `nothing_staged: nothing is staged and workit never commits unrelated changes implicitly (${dirt.length} changed: ${dirt
          .slice(0, 5)
          .map((entry) => entry.slice(3))
          .join(", ")}${dirt.length > 5 ? ", …" : ""})`,
        `workit git commit -m '<msg>' -- <paths>  # or --all to commit every change`,
      );
    }
  }
  const committed = git(cwd, args, {
    timeoutMs: COMMIT_TIMEOUT_MS,
    env: input.env,
  });
  if (!committed.ok)
    return failure(
      "failed",
      `git commit failed (a hook or git refused it):\n${gitOutput(committed)}`,
    );
  const sha = headSha(cwd);
  if (!sha) return failure("failed", "the commit did not resolve");
  // A merge commit lists what it brought in relative to its first parent.
  const merge = git(cwd, ["rev-parse", "-q", "--verify", `${sha}^2`]).ok;
  const files = nulList(
    git(
      cwd,
      merge
        ? ["diff", "--name-only", "-z", `${sha}^1`, sha]
        : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha],
    ).stdout,
  );
  const leftDirty = dirtEntries(cwd).length;
  const notes: string[] = [];
  // Only a commit on the branch's own upstream needs a forced push.
  const upstream = `refs/remotes/${pushRemoteName(cwd, branch) ?? "origin"}/${branch}`;
  if (previous && git(cwd, ["merge-base", "--is-ancestor", previous, upstream]).ok)
    notes.push(
      `the amended commit ${previous.slice(0, 12)} was already pushed (${upstream.slice("refs/remotes/".length)}); publish the rewrite with: workit git push --force-with-lease`,
    );

  // Bounded row (MAX_LINE_BYTES): the subject and the first files only.
  const listed: string[] = [];
  let size = 0;
  for (const file of files) {
    size += file.length + 4;
    if (size > 1500) break;
    listed.push(file);
  }
  const row = appendObserved(cwd, {
    type: "commit.recorded",
    actor: input.actor,
    branch,
    head: sha,
    sha,
    session,
    agentId: input.actor.agentId,
    subject: (message.split("\n", 1)[0] ?? "").slice(0, 200),
    files: listed,
    fileCount: files.length,
    ...(previous ? { amended: previous } : {}),
  });
  return success({
    sha,
    branch,
    message,
    files,
    leftDirty,
    session,
    amended: previous,
    notes,
    recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
  });
}

// ---------------------------------------------------------------------------
// push

export type PushPlan = {
  branch: string;
  sha: string;
  remote: string;
  /** Redacted push URL (safe to print). */
  url: string;
  /** The push URL as configured (ls-remote target); never printed. */
  rawUrl: string;
  /** The remote is a local path/file URL: there is no forge account to check. */
  local: boolean;
};

/** Everything `git push` needs that does not touch the network. */
export function pushPreflight(
  cwd: string,
  options: { branch?: string | null } = {},
): ForgeResult<PushPlan> {
  const progress = operationInProgress(cwd);
  if (progress) return inProgressFailure(progress.operation, "push");
  const branch = options.branch ?? currentBranch(cwd);
  if (!branch) return failure("invalid_input", "HEAD is detached; push a branch");
  if (isProtectedTarget(cwd, branch))
    return failure(
      "blocked",
      `protected_branch: ${branch} is protected by the workspace branch policy; workit never pushes to it`,
      "workit git branch <feature/name>  # push a feature branch and open a PR",
    );
  const sha = resolveRef(cwd, `refs/heads/${branch}`);
  if (!sha) return failure("not_found", `branch ${branch} has no commit to push`);
  const remote = pushRemoteName(cwd, branch);
  if (!remote)
    return failure(
      "not_found",
      "no push remote is configured for this branch",
      "git remote add origin <url>",
    );
  const raw = pushUrl(cwd, remote);
  if (!raw)
    return failure(
      "blocked",
      `remote "${remote}" has no single push URL`,
      `git remote get-url --push --all ${remote}  # keep exactly one push URL`,
    );
  const parsed = parseRemoteUrl(raw);
  const local = parsed?.protocol === "file";
  // `git remote get-url --push` already applied the rewrites; a URL that a
  // rule would rewrite again is ambiguous. A local path is taken as is.
  if (!local && !pushTargetIsStable(cwd, raw))
    return failure(
      "blocked",
      `push_target_rewritten: the push URL of "${remote}" is rewritten by a url.*.insteadOf rule, so the destination is not the one checked`,
      "git config --get-regexp '^url\\.'  # remove the rewrite for this remote",
    );
  return success({
    branch,
    sha,
    remote,
    url: redactRemote(raw),
    rawUrl: raw,
    local,
  });
}

/**
 * The remote tip workit last pushed for `branch`: the newest `push.verified`
 * row where workit actually moved the ref (`pushed: true`). A no-op push only
 * observed someone's tip (`push.noop`) and is never a lease anchor. The remote-tracking ref is never a lease (a plain `git fetch`
 * moves it to someone else's tip, which would make the force overwrite
 * them). `undefined` means workit has no record.
 */
export function recordedRemoteTip(cwd: string, plan: PushPlan): string | undefined {
  const ledger = readLedger(cwd);
  if (ledger.ok)
    for (let index = ledger.value.rows.length - 1; index >= 0; index -= 1) {
      const row = ledger.value.rows[index];
      if (
        row.type === "push.verified" &&
        row.pushed === true &&
        row.branch === plan.branch &&
        row.observer === "workit_cli" &&
        row.head
      )
        return row.head;
    }
  return undefined;
}

/**
 * `--force-if-includes` semantics: the remote tip was integrated locally, i.e.
 * it is reachable from the local branch or from a former tip in the branch's
 * reflog (the branch held it before an amend or rebase). Reachability only:
 * this guards what a forced push may drop.
 */
function includesRemoteTip(cwd: string, branch: string, tip: string): boolean {
  const ref = `refs/heads/${branch}`;
  if (git(cwd, ["merge-base", "--is-ancestor", tip, ref]).ok) return true;
  const reflog = git(cwd, ["reflog", "show", "--format=%H", ref, "--"]);
  const former = [
    ...new Set(
      (reflog.ok ? reflog.stdout : "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (former.includes(tip)) return true;
  if (!former.length) return false;
  // Commits reachable from the tip but from no former tip: none means included.
  const outside = git(cwd, ["rev-list", "-n", "1", "--stdin"], {
    input: `${tip}\n${former.map((sha) => `^${sha}`).join("\n")}\n`,
  });
  return outside.ok && !outside.stdout.trim();
}

/**
 * Every commit the remote tip has and the branch lacks is a non-merge commit
 * with a patch-equivalent local commit (the same work, rebased elsewhere).
 * Only words the push advice; it never relaxes the lease guard, because a
 * merge commit can carry changes no patch-id shows.
 */
function patchEquivalent(cwd: string, branch: string, tip: string): boolean {
  const ref = `refs/heads/${branch}`;
  const merges = git(cwd, ["rev-list", "--count", "--merges", `${ref}..${tip}`]);
  if (!merges.ok || merges.stdout.trim() !== "0") return false;
  const cherry = git(cwd, ["cherry", ref, tip]);
  const lines = cherry.ok ? cherry.stdout.split("\n").filter(Boolean) : [];
  return lines.length > 0 && lines.every((line) => line.startsWith("-"));
}

export type PushOutcome = {
  remote: string;
  url: string;
  branch: string;
  sha: string;
  /** The remote tip before the push (null: the branch was new). */
  previous: string | null;
  pushed: boolean;
  forced: boolean;
  delivered: true;
  upstream: boolean;
  recorded: { id: string } | { error: string };
};

const SHA = /^[0-9a-f]{40,64}$/u;
const SHA_PREFIX = /^[0-9a-f]{7,39}$/u;

/** Resolve an abbreviated `--expect` against the known remote tips; refuse unknown or ambiguous. */
export function resolveExpectPrefix(
  prefix: string,
  tips: ReadonlyArray<string | null | undefined>,
  label: string,
): { ok: true; sha: string } | { ok: false; code: "invalid_input"; error: string } {
  const known = [...new Set(tips.filter((tip): tip is string => typeof tip === "string"))];
  if (!SHA_PREFIX.test(prefix))
    return {
      ok: false,
      code: "invalid_input",
      error: "--expect must be a commit sha (full, or an abbreviation of at least 7 hex digits)",
    };
  const matches = known.filter((tip) => tip.startsWith(prefix));
  if (matches.length === 1) return { ok: true, sha: matches[0] };
  return {
    ok: false,
    code: "invalid_input",
    error:
      matches.length > 1
        ? `--expect ${prefix} is ambiguous for ${label}; choose one of: ${matches.join(", ")}`
        : `--expect ${prefix} matches no known tip of ${label}${known.length ? `; known: ${known.join(", ")}` : ""}; pass the full sha`,
  };
}

export function executePush(
  cwd: string,
  plan: PushPlan,
  input: {
    forceWithLease?: boolean;
    /** Allow a lease on a remote tip local history never contained (drops those commits). */
    overwriteUnintegrated?: boolean;
    expect?: string | null;
    setUpstream?: boolean;
    actor: LedgerActor;
    timeoutMs?: number;
    /** The pre-push identity check's outcome, kept on the ledger row. */
    identity?: Record<string, unknown>;
  },
): ForgeResult<PushOutcome> {
  const before = remoteRefTip(cwd, plan.rawUrl, `refs/heads/${plan.branch}`);
  if (!before.ok) return failure(before.code, before.error);
  let forced = false;
  let pushed = false;
  if (before.sha !== plan.sha) {
    const args = ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no"];
    if (input.forceWithLease) {
      const explicit = input.expect !== undefined && input.expect !== null;
      let expectSha = input.expect ?? null;
      if (explicit && !SHA.test(expectSha as string)) {
        const resolved = resolveExpectPrefix(
          expectSha as string,
          [before.sha, recordedRemoteTip(cwd, plan)],
          `${plan.remote}/${plan.branch}`,
        );
        if (!resolved.ok) return failure(resolved.code, resolved.error);
        expectSha = resolved.sha;
      }
      const integrate = `git fetch ${plan.remote} ${plan.branch} && git rebase ${plan.remote}/${plan.branch}  # or merge it; then: workit git push`;
      const recorded = explicit ? (expectSha as string) : recordedRemoteTip(cwd, plan);
      // A new branch needs no lease; otherwise workit must have recorded the tip.
      if (recorded === undefined && before.sha !== null)
        return failure(
          "blocked",
          `lease_unknown: workit has no recorded push of ${plan.branch}, so it cannot tell whose commits ${plan.remote}/${plan.branch} (${before.sha.slice(0, 12)}) holds`,
          `${integrate}  # or, after reviewing that tip: workit git push --force-with-lease --expect <sha you reviewed> (--overwrite-unintegrated only to drop commits you never had)`,
        );
      const expected = recorded ?? null;
      if (before.sha !== expected)
        return failure(
          "blocked",
          `lease_mismatch: ${plan.remote}/${plan.branch} is at ${before.sha?.slice(0, 12) ?? "(absent)"} but ${explicit ? "--expect names" : "workit last recorded"} ${expected?.slice(0, 12) ?? "(absent)"}; someone else pushed`,
          integrate,
        );
      if (
        !input.overwriteUnintegrated &&
        before.sha !== null &&
        !includesRemoteTip(cwd, plan.branch, before.sha)
      )
        return failure(
          "blocked",
          `lease_not_integrated: ${plan.remote}/${plan.branch} (${before.sha.slice(0, 12)}) was never part of local ${plan.branch}; forcing would drop it`,
          `${integrate}  # or, to drop those commits on purpose: workit git push --force-with-lease --expect ${before.sha} --overwrite-unintegrated`,
        );
      args.push(`--force-with-lease=refs/heads/${plan.branch}:${expected ?? ""}`);
      forced = true;
    }
    args.push(plan.remote, `${plan.sha}:refs/heads/${plan.branch}`);
    const run = gitNetwork(cwd, args, input.timeoutMs ?? PUSH_TIMEOUT_MS);
    if (!run.ok) {
      const text = `${run.stderr}\n${run.stdout}`;
      if (run.timedOut) return failure("unavailable", `git push to ${plan.url} timed out`);
      if (/stale info/iu.test(text))
        return failure(
          "blocked",
          `lease_mismatch: ${plan.remote}/${plan.branch} moved while pushing`,
          `git fetch ${plan.remote} ${plan.branch} && git rebase ${plan.remote}/${plan.branch}  # or merge it; then: workit git push`,
        );
      const rejected = /non-fast-forward|fetch first|\[rejected\]/iu.test(text);
      const integrated =
        rejected && before.sha !== null && includesRemoteTip(cwd, plan.branch, before.sha);
      const equivalent =
        rejected &&
        !integrated &&
        before.sha !== null &&
        patchEquivalent(cwd, plan.branch, before.sha);
      if (before.sha !== null && (integrated || equivalent)) {
        // An amend or rebase rewrote commits that are already pushed: a fetch
        // and rebase would re-apply the old ones. The lease is the tip seen now.
        const lease =
          recordedRemoteTip(cwd, plan) === before.sha
            ? "workit git push --force-with-lease"
            : `workit git push --force-with-lease --expect ${before.sha}`;
        return failure(
          "failed",
          integrated
            ? `non_fast_forward: local ${plan.branch} was rewritten (amend or rebase) after ${plan.remote}/${plan.branch} (${before.sha.slice(0, 12)}) was pushed; that tip is already part of the local history, so do not fetch and rebase`
            : `non_fast_forward: every commit on ${plan.remote}/${plan.branch} (${before.sha.slice(0, 12)}) has a patch-equivalent commit in local ${plan.branch} (rebased elsewhere); fetching and rebasing would apply them twice`,
          integrated
            ? lease
            : `${lease} --overwrite-unintegrated  # after checking ${plan.remote}/${plan.branch} holds nothing else`,
        );
      }
      if (/non-fast-forward|fetch first|\[rejected\]/iu.test(text))
        return failure(
          "failed",
          `non_fast_forward: ${plan.remote}/${plan.branch} has commits this branch does not`,
          `git fetch ${plan.remote} && git rebase ${plan.remote}/${plan.branch}  # or, if the rewrite is intended: workit git push --force-with-lease`,
        );
      return failure("failed", `git push to ${plan.url} failed:\n${gitOutput(run)}`);
    }
    pushed = true;
  }
  const after = remoteRefTip(cwd, plan.rawUrl, `refs/heads/${plan.branch}`);
  if (!after.ok)
    return failure(
      after.code,
      `push sent but not verified: ${after.error}`,
      "workit verify-delivery push",
    );
  if (after.sha !== plan.sha)
    return failure(
      "failed",
      `push_unverified: ${plan.remote}/${plan.branch} is at ${after.sha?.slice(0, 12) ?? "(absent)"}, not the pushed ${plan.sha.slice(0, 12)}`,
      "workit verify-delivery push",
    );
  let upstream = false;
  if (input.setUpstream) {
    upstream =
      git(cwd, ["config", `branch.${plan.branch}.remote`, plan.remote]).ok &&
      git(cwd, ["config", `branch.${plan.branch}.merge`, `refs/heads/${plan.branch}`]).ok;
  }
  // Only a push that moved the ref is a lease anchor; a no-op merely observed it.
  const row = appendObserved(cwd, {
    type: pushed ? "push.verified" : "push.noop",
    actor: input.actor,
    branch: plan.branch,
    head: plan.sha,
    remote: plan.remote,
    url: plan.url,
    previous: before.sha,
    pushed,
    forced,
    ...(input.identity ? { identity: input.identity } : {}),
  });
  return success({
    remote: plan.remote,
    url: plan.url,
    branch: plan.branch,
    sha: plan.sha,
    previous: before.sha,
    pushed,
    forced,
    delivered: true,
    upstream,
    recorded: row.ok ? { id: String(row.value.id) } : { error: row.error },
  });
}

/**
 * Delete a remote branch only while it still points at `expectedTip`
 * (`--force-with-lease=refs/heads/<b>:<tip> --delete`). `lease` is false when
 * the tip moved; nothing is deleted then.
 */
export function deleteRemoteBranch(
  cwd: string,
  target: string,
  branch: string,
  expectedTip: string,
  options: { timeoutMs?: number } = {},
): { ok: true } | { ok: false; lease: boolean; error: string } {
  if (target.startsWith("-") || branch.startsWith("-") || !SHA.test(expectedTip))
    return { ok: false, lease: false, error: "invalid branch deletion target" };
  if (isProtectedTarget(cwd, branch))
    return {
      ok: false,
      lease: false,
      error: `${branch} is a protected branch; it is never deleted`,
    };
  const run = gitNetwork(
    cwd,
    [
      "push",
      "--no-follow-tags",
      "--recurse-submodules=no",
      `--force-with-lease=refs/heads/${branch}:${expectedTip}`,
      "--delete",
      target,
      branch,
    ],
    options.timeoutMs ?? PUSH_TIMEOUT_MS,
  );
  if (run.ok) return { ok: true };
  const text = `${run.stderr}\n${run.stdout}`;
  return /stale info|cannot lock ref|fetch first|non-fast-forward/iu.test(text)
    ? {
        ok: false,
        lease: true,
        error: "the remote branch tip changed before deletion",
      }
    : { ok: false, lease: false, error: gitError(run) };
}
