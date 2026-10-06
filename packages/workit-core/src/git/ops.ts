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

type Run = { ok: boolean; status: number | null; stdout: string; stderr: string };

const git = (
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Run => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? GIT_TIMEOUTS.local,
    killSignal: "SIGKILL",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
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
  // One resolution: the default target, the base for new branches and the
  // release track (core/release-tracks.ts) all come from vcsConfig.
  const resolved = vcsConfig("resolve", cwd, { track: input.track ?? null });
  const releaseTrack: ResolvedReleaseTrack | null =
    resolved.ok === false ? null : (resolved.releaseTrack ?? null);
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

  let base = input.base?.trim() || null;
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

export function gitCommit(
  cwd: string,
  input: {
    message: string;
    all?: boolean;
    paths?: readonly string[];
    actor: LedgerActor;
    env?: NodeJS.ProcessEnv;
  },
): ForgeResult<CommitOutcome> {
  const message = input.message.trim();
  if (!message) return failure("invalid_input", "a commit message is required (-m <msg>)");
  const paths = input.paths ?? [];
  if (input.all && paths.length) return failure("invalid_input", "pass --all or paths, not both");
  const branch = currentBranch(cwd);
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
  const lint = lintCommitMessage(cwd, message);
  if (!lint.ok) return failure("blocked", lint.error, lint.correction);
  const session = input.actor.session;
  if (session && !SESSION_SAFE.test(session))
    return failure(
      "invalid_input",
      "WORKIT_SESSION_ID must be 1-128 characters of [A-Za-z0-9_.:@/+-]",
    );

  const args = ["commit", "--no-edit", "-m", message];
  if (session) args.push("--trailer", `Workit-Session: ${session}`);
  if (paths.length) {
    if (paths.some((value) => value.startsWith("-") || !value.trim()))
      return failure("invalid_input", "paths must not be empty or start with -");
    const added = git(cwd, ["add", "-A", "--", ...paths]);
    if (!added.ok) return failure("failed", `git add failed: ${gitError(added)}`);
    args.push("--", ...paths);
  } else if (input.all) {
    const added = git(cwd, ["add", "-A"]);
    if (!added.ok) return failure("failed", `git add failed: ${gitError(added)}`);
  } else {
    const staged = git(cwd, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.ok && !staged.stdout.replaceAll("\0", "")) {
      const dirt = dirtEntries(cwd);
      return failure(
        dirt.length ? "blocked" : "failed",
        dirt.length
          ? `nothing_staged: nothing is staged and workit never commits unrelated changes implicitly (${dirt.length} changed: ${dirt
              .slice(0, 5)
              .map((entry) => entry.slice(3))
              .join(", ")}${dirt.length > 5 ? ", …" : ""})`
          : "nothing_to_commit: the working tree is clean",
        dirt.length
          ? `workit git commit -m '<msg>' -- <paths>  # or --all to commit every change`
          : undefined,
      );
    }
  }
  const committed = git(cwd, args, { timeoutMs: COMMIT_TIMEOUT_MS, env: input.env });
  if (!committed.ok) return failure("failed", `git commit failed: ${gitError(committed, 6)}`);
  const sha = headSha(cwd);
  if (!sha) return failure("failed", "the commit did not resolve");
  const files = nulList(
    git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha]).stdout,
  );
  const leftDirty = dirtEntries(cwd).length;

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
  });
  return success({
    sha,
    branch,
    message,
    files,
    leftDirty,
    session,
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
 * it is reachable from the local branch or appears in the branch's reflog
 * (the commit was this branch's tip before a rebase/amend).
 */
function includesRemoteTip(cwd: string, branch: string, tip: string): boolean {
  if (git(cwd, ["merge-base", "--is-ancestor", tip, `refs/heads/${branch}`]).ok) return true;
  const reflog = git(cwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]);
  return reflog.ok && reflog.stdout.split("\n").some((line) => line.trim() === tip);
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
      if (explicit && !SHA.test(input.expect as string))
        return failure("invalid_input", "--expect must be a full commit sha");
      const integrate = `git fetch ${plan.remote} ${plan.branch} && git rebase ${plan.remote}/${plan.branch}  # or merge it; then: workit git push`;
      const recorded = explicit ? (input.expect as string) : recordedRemoteTip(cwd, plan);
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
      if (/non-fast-forward|fetch first|\[rejected\]/iu.test(text))
        return failure(
          "failed",
          `non_fast_forward: ${plan.remote}/${plan.branch} has commits this branch does not`,
          `git fetch ${plan.remote} && git rebase ${plan.remote}/${plan.branch}  # or, if the rewrite is intended: workit git push --force-with-lease`,
        );
      return failure("failed", `git push to ${plan.url} failed: ${gitError(run)}`);
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
    ? { ok: false, lease: true, error: "the remote branch tip changed before deletion" }
    : { ok: false, lease: false, error: gitError(run) };
}
