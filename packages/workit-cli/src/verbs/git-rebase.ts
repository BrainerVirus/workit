// `workit git rebase [--onto <base>]`: replay the current branch onto its
// freshly fetched base. A conflict aborts the rebase, so the branch is left
// exactly where it was; a rewrite is recorded and names the leased push.
import { isProtectedTarget } from "@workit-dev/core/src/core/branch";
import { defaultBase } from "@workit-dev/core/src/git/default-base";
import {
  git,
  gitError,
  inProgressFailure,
  operationInProgress,
} from "@workit-dev/core/src/git/ops";
import {
  currentBranch,
  fetchRefs,
  GIT_TIMEOUTS,
  pushRemoteName,
  remoteNames,
  resolveRef,
} from "@workit-dev/core/src/git/rev";
import { failure, success, type ForgeResult } from "@workit-dev/core/src/forge/types";
import { actorFromEnv, appendObserved } from "@workit-dev/core/src/ledger";
import { emit, ok, type Io } from "../output";
import { forgeFail, parseFlags, usage } from "./forge-common";

const REBASE_USAGE = "workit git rebase [--onto <base>] [--json]";

const short = (sha: string): string => sha.slice(0, 12);

type RebaseOutcome = {
  branch: string;
  base: string;
  baseSha: string;
  previous: string;
  head: string;
  rebased: boolean;
  /** Commits on the branch after the base, once rebased. */
  commits: number;
  /** The command that publishes the result; null when nothing changed. */
  next: string | null;
  recorded: { id: string } | { error: string } | null;
};

/** `origin/main` -> remote origin, branch main; a local ref -> null. */
function remoteBranchOf(cwd: string, base: string): { remote: string; branch: string } | null {
  if (resolveRef(cwd, `refs/heads/${base}`)) return null;
  const slash = base.indexOf("/");
  if (slash <= 0) return null;
  const remote = base.slice(0, slash);
  const branch = base.slice(slash + 1);
  return branch && remoteNames(cwd).includes(remote) ? { remote, branch } : null;
}

/** The base to rebase onto, fetched when it is a remote-tracking branch. */
function freshBase(cwd: string, onto: string | null): ForgeResult<{ base: string; sha: string }> {
  const base = onto ?? defaultBase(cwd);
  if (!base)
    return failure(
      "not_found",
      "no default base found (origin/HEAD, origin/main, main …)",
      "workit git rebase --onto <base>",
    );
  if (base.startsWith("-")) return failure("invalid_input", "--onto must name a ref");
  const tracked = remoteBranchOf(cwd, base);
  if (tracked) {
    const fetched = fetchRefs(cwd, tracked.remote, [
      `+refs/heads/${tracked.branch}:refs/remotes/${tracked.remote}/${tracked.branch}`,
    ]);
    if (!fetched.ok)
      return failure(
        fetched.code,
        `${fetched.error}; nothing was rebased onto a stale ${base}`,
        `workit git rebase --onto ${base}  # retry once the remote answers`,
      );
  }
  const sha = resolveRef(cwd, `${base}^{commit}`);
  if (!sha) return failure("not_found", `base ${base} does not resolve to a commit`);
  return success({ base, sha });
}

const conflictedPaths = (cwd: string): string[] =>
  git(cwd, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** A conflict: the rebase was aborted; `conflicts` names the paths. */
type RebaseConflict = {
  ok: false;
  code: "failed";
  error: string;
  unblock: string;
  conflicts: string[];
};

function rebaseOnto(
  cwd: string,
  io: Io,
  onto: string | null,
): ForgeResult<RebaseOutcome> | RebaseConflict {
  const progress = operationInProgress(cwd);
  if (progress) return inProgressFailure(progress.operation, "rebase");
  const branch = currentBranch(cwd);
  if (!branch) return failure("invalid_input", "HEAD is detached; rebase a branch");
  if (isProtectedTarget(cwd, branch))
    return failure(
      "blocked",
      `protected_branch: ${branch} is protected by the workspace branch policy; workit never rebases it`,
      "workit git branch <feature/name>  # rebase a feature branch",
    );
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok) return failure("failed", `git status failed: ${gitError(dirty)}`);
  if (dirty.stdout.trim())
    return failure(
      "blocked",
      `uncommitted changes to tracked files; workit rebases a clean ${branch} only`,
      "workit git commit -m '<msg>' -- <paths>  # or stash them, then rerun",
    );
  const previous = resolveRef(cwd, `refs/heads/${branch}`);
  if (!previous) return failure("not_found", `branch ${branch} has no commit to rebase`);
  const fresh = freshBase(cwd, onto);
  if (!fresh.ok) return fresh;
  const { base, sha: baseSha } = fresh.data;
  if (remoteBranchOf(cwd, base)?.branch === branch || base === branch)
    return failure(
      "blocked",
      `${branch} is its own base (${base}); rebase a feature branch onto it instead`,
    );

  const run = git(
    cwd,
    ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "rebase", "--quiet", base],
    {
      env: { ...io.env, GIT_EDITOR: "true" },
      timeoutMs: GIT_TIMEOUTS.worktree,
    },
  );
  if (!run.ok) {
    const conflicts = conflictedPaths(cwd);
    const stopped = operationInProgress(cwd) !== null;
    const aborted = stopped ? git(cwd, ["rebase", "--abort"]).ok : true;
    const restored = resolveRef(cwd, "HEAD") === previous && currentBranch(cwd) === branch;
    if (!aborted || !restored)
      return failure(
        "failed",
        `rebase of ${branch} onto ${base} failed and could not be undone: ${gitError(run)}`,
        `git -C ${cwd} rebase --abort  # then check ${branch} is back at ${short(previous)}`,
      );
    if (conflicts.length)
      return {
        ok: false,
        code: "failed",
        error: `rebase_conflict: ${branch} conflicts with ${base} (${short(baseSha)}) in ${conflicts.join(", ")}; the rebase was aborted and ${branch} is unchanged at ${short(previous)}`,
        unblock: `merge ${base} into ${branch}, resolve ${conflicts.join(", ")} and push with workit git push; or rebase by hand and push with workit git push --force-with-lease`,
        conflicts,
      };
    return failure(
      "failed",
      `rebase of ${branch} onto ${base} failed: ${gitError(run)}; ${branch} is unchanged at ${short(previous)}`,
    );
  }

  const head = resolveRef(cwd, "HEAD") ?? previous;
  const rebased = head !== previous;
  const count = git(cwd, ["rev-list", "--count", `${baseSha}..${head}`]);
  const commits = count.ok ? Number(count.stdout.trim()) || 0 : 0;
  const remote = pushRemoteName(cwd, branch);
  const published = remote !== null && resolveRef(cwd, `refs/remotes/${remote}/${branch}`) !== null;
  const next = rebased
    ? published
      ? "workit git push --force-with-lease"
      : "workit git push --set-upstream"
    : null;
  let recorded: RebaseOutcome["recorded"] = null;
  if (rebased) {
    const row = appendObserved(cwd, {
      type: "branch.rebased",
      actor: actorFromEnv(io.env),
      branch,
      base,
      baseSha,
      previous,
      head,
    });
    recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
  }
  return success({
    branch,
    base,
    baseSha,
    previous,
    head,
    rebased,
    commits,
    next,
    recorded,
  });
}

export function rebase(argv: string[], io: Io): number {
  const flags = parseFlags(argv, { onto: "value" });
  if (typeof flags === "string") return usage(io, flags, REBASE_USAGE);
  if (flags.positionals.length)
    return usage(
      io,
      `unexpected argument ${flags.positionals[0]} (workit rebases the current branch: --onto <base> picks another base)`,
      REBASE_USAGE,
    );
  const result = rebaseOnto(io.cwd, io, flags.values.onto ?? null);
  if (!result.ok) {
    const data =
      "conflicts" in result
        ? { reason: "rebase_conflict", conflicts: result.conflicts }
        : undefined;
    return forgeFail(io, result, data);
  }
  return emit(io, ok(result.data), (data: RebaseOutcome) =>
    data.rebased
      ? [
          `rebased ${data.branch} onto ${data.base} (${short(data.baseSha)}): ${short(data.previous)} -> ${short(data.head)}, ${data.commits} commit${data.commits === 1 ? "" : "s"}`,
          ...(data.recorded && "error" in data.recorded
            ? [`ledger: not recorded (${data.recorded.error})`]
            : []),
          `next: ${data.next}`,
        ]
      : [`${data.branch} is already up to date with ${data.base} (${short(data.baseSha)})`],
  );
}
