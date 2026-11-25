// `pr merge` on a PR the forge reports conflicting (or needing a rebase)
// (#923). GitHub's server-side merge ignores Workit's changelog merge driver,
// so parallel PRs that each add an Unreleased line conflict one after another.
// When git here shows the workspace changelog as the only conflicting path and
// the driver merges it, the PR branch is rebased with the driver and pushed
// with a lease on the PR head, then `pr merge` stops: the new head needs its
// CI, which this call never waits for. Anything else refuses with the exact
// commands, and nothing is pushed.
import { requireGrant } from "../autonomy";
import { isChangelogPath } from "../core/changelog-gate";
import { mergeChangelogText } from "../core/changelog-merge";
import { pushTarget } from "../core/remotes";
import { workspaceChangelog } from "../core/workspaces";
import { executePush, git, gitError, pushPreflight, operationInProgress } from "../git/ops";
import type { PushPlan } from "../git/ops";
import {
  currentBranch,
  fetchRefs,
  GIT_TIMEOUTS,
  hasCommit,
  remoteRefTip,
  resolveRef,
} from "../git/rev";
import type { LedgerActor } from "../ledger";
import { rebaseOnto } from "./merge-rebase-onto";
import type { PrStatusDoc } from "./report";
import type { ResolvedForge } from "./resolve";
import type { ForgeResult } from "./types";

/** Test seam: where the rebased branch is pushed (the forge push URL in production). */
export const mergeRebaseDeps = {
  pushPlan: (cwd: string, branch: string): ForgeResult<PushPlan> => pushPreflight(cwd, { branch }),
};

export type ChangelogRebased = {
  branch: string;
  /** The remote-tracking base the branch was replayed onto (`origin/main`). */
  onto: string;
  baseSha: string;
  previous: string;
  head: string;
  /** The changelog paths the driver merged. */
  changelog: string[];
  rebaseRecorded: { id: string } | { error: string } | null;
  pushRecorded: { id: string } | { error: string };
  /** The commands to run next, in order. */
  next: string[];
};

export type ChangelogRebase =
  | { ok: true; data: ChangelogRebased; message: string; unblock: string }
  | {
      ok: false;
      code: "blocked" | "failed";
      /** Why nothing was rebased (or pushed), appended to the not_ready refusal. */
      why: string;
      unblock: string;
      /** The paths git here reports conflicting with the base; null when unread. */
      conflicts: string[] | null;
    };

const short = (sha: string): string => sha.slice(0, 12);

const quote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** The paths `head` conflicts in when merged into `base`, read by git without a checkout. */
function conflictedPaths(
  cwd: string,
  base: string,
  head: string,
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const run = git(
    cwd,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, head],
    { timeoutMs: GIT_TIMEOUTS.worktree },
  );
  if (run.status !== 0 && run.status !== 1) return { ok: false, error: gitError(run) };
  if (run.status === 0) return { ok: true, paths: [] };
  const [, ...paths] = run.stdout.split("\0").filter(Boolean);
  return { ok: true, paths: [...new Set(paths)] };
}

/** Whether the changelog merge driver merges `file` cleanly (base side as ours, like a rebase). */
function driverMerges(cwd: string, base: string, head: string, file: string): boolean {
  const fork = git(cwd, ["merge-base", base, head]);
  if (!fork.ok) return false;
  const show = (rev: string) => git(cwd, ["show", `${rev}:${file}`]);
  const [ancestor, ours, theirs] = [show(fork.stdout.trim()), show(base), show(head)];
  if (!ancestor.ok || !ours.ok || !theirs.ok) return false;
  const merged = mergeChangelogText(ancestor.stdout, ours.stdout, theirs.stdout);
  return !("error" in merged) && merged.clean;
}

/** The other worktree of this repository that has `branch` checked out, or null. */
function worktreeOf(cwd: string, branch: string): string | null {
  const listed = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return null;
  let path: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

const isAncestor = (cwd: string, older: string, newer: string): boolean =>
  git(cwd, ["merge-base", "--is-ancestor", older, newer]).ok;

export type ChangelogRebaseInput = {
  doc: PrStatusDoc;
  label: string;
  /** The command that repeats this merge (`workit pr merge --method squash`). */
  again: string;
  /** The `workit ci wait` that watches this PR. */
  ciWait: string;
  actor: LedgerActor;
  /** Why the PR is not shown to be the caller's own (another author, an unread identity); null when it is. */
  notYours: string | null;
};

/**
 * Settle a forge-reported conflict that is only the workspace changelog: read
 * the conflict locally, check this checkout may rewrite the branch, rebase
 * with the driver and push with a lease on the PR head. Never merges.
 */
export function rebaseChangelogConflict(
  cwd: string,
  resolved: ResolvedForge,
  input: ChangelogRebaseInput,
): ChangelogRebase {
  const { doc, label, again, ciWait } = input;
  const branch = doc.head.branch;
  const head = doc.head.sha;
  const onto = `${resolved.baseRemote}/${doc.base}`;
  const steps = `workit git rebase --onto ${onto}, workit git push --force-with-lease, ${ciWait}, and ${again}`;
  const byHand = `workit git rebase --onto ${onto}  # then: workit git push --force-with-lease, ${ciWait}, and ${again}`;
  const refuse = (why: string, unblock: string, conflicts: string[] | null): ChangelogRebase => ({
    ok: false,
    code: "blocked",
    why,
    unblock,
    conflicts,
  });

  const fetched = fetchRefs(cwd, resolved.baseRemote, [
    `+refs/heads/${doc.base}:refs/remotes/${resolved.baseRemote}/${doc.base}`,
  ]);
  if (!fetched.ok)
    return refuse(
      `${onto} could not be fetched to read the conflict (${fetched.error})`,
      byHand,
      null,
    );
  const baseSha = resolveRef(cwd, `refs/remotes/${onto}^{commit}`);
  if (!baseSha) return refuse(`${onto} does not resolve to a commit after the fetch`, byHand, null);
  if (!hasCommit(cwd, head)) fetchRefs(cwd, resolved.remote, [head]);
  if (!hasCommit(cwd, head))
    return refuse(
      `the PR head ${short(head)} could not be fetched from ${resolved.remote}`,
      byHand,
      null,
    );

  const read = conflictedPaths(cwd, baseSha, head);
  if (!read.ok)
    return refuse(
      `the conflicting paths could not be read (git merge-tree, git 2.38+: ${read.error})`,
      byHand,
      null,
    );
  const conflicts = read.paths;
  if (!conflicts.length)
    return refuse(
      `git here merges ${short(head)} into ${onto} (${short(baseSha)}) without a conflict`,
      byHand,
      conflicts,
    );
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const changelogPaths = top.ok ? workspaceChangelog(top.stdout.trim()).paths : [];
  const outside = conflicts.filter((file) => !isChangelogPath(changelogPaths, file));
  const unmerged = outside.length
    ? []
    : conflicts.filter((file) => !driverMerges(cwd, baseSha, head, file));
  if (outside.length || unmerged.length) {
    const stuck = outside.length ? outside : unmerged;
    return refuse(
      outside.length
        ? `it conflicts with ${onto} in ${conflicts.join(", ")}; ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the changelog, so Workit does not resolve the conflict`
        : `${unmerged.join(", ")} conflicts with ${onto} outside its Unreleased entries, which the changelog merge driver does not resolve`,
      `workit git rebase --onto ${onto}  # it stops on ${stuck.join(", ")}: then merge ${onto} into ${branch}, resolve and commit, workit git push, ${ciWait}, and ${again}`,
      conflicts,
    );
  }

  const files = conflicts.join(", ");
  const notAuto = (why: string, unblock: string) =>
    refuse(
      `only ${files} conflicts, which Workit's changelog merge driver resolves, but ${branch} was not rebased automatically: ${why}`,
      unblock,
      conflicts,
    );
  if (doc.headRepo !== null) return notAuto(`${label} comes from a fork (${doc.headRepo})`, byHand);
  if (input.notYours !== null)
    return notAuto(`${input.notYours}; workit never rewrites another author's branch`, byHand);
  const here = currentBranch(cwd);
  if (here !== branch) {
    const elsewhere = worktreeOf(cwd, branch);
    return elsewhere
      ? notAuto(
          `${branch} is checked out in ${elsewhere}, not in this checkout`,
          `${again} --cwd ${quote(elsewhere)}  # rebases and pushes it there; or by hand there: ${steps}`,
        )
      : notAuto(
          `${branch} is not checked out here (this checkout is on ${here ?? "a detached HEAD"})`,
          `git switch ${branch}  # then: ${again} rebases and pushes it; or by hand: ${steps}`,
        );
  }
  const progress = operationInProgress(cwd);
  if (progress)
    return notAuto(
      `a git ${progress.operation} is in progress in this checkout`,
      `git ${progress.operation === "am" ? "am" : progress.operation} --abort  # or finish it; then: ${again}`,
    );
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok || dirty.stdout.trim())
    return notAuto(
      dirty.ok
        ? "this checkout has uncommitted changes to tracked files"
        : `git status failed (${gitError(dirty)})`,
      `git stash  # then: ${again} rebases and pushes it, and git stash pop; or by hand: ${steps}`,
    );
  const local = resolveRef(cwd, `refs/heads/${branch}`);
  if (local !== head) {
    const at = `local ${branch} is at ${local ? short(local) : "(none)"}, but the PR head is ${short(head)}`;
    if (local && isAncestor(cwd, local, head))
      return notAuto(at, `git merge --ff-only ${head}  # then: ${again}`);
    if (local && isAncestor(cwd, head, local))
      return notAuto(`${at} (local is ahead)`, `workit git push  # then: ${again}`);
    return notAuto(
      `${at} (they diverged)`,
      `git fetch ${resolved.remote} ${branch}  # reconcile local ${branch} with ${short(head)}, then: ${again}`,
    );
  }
  const plan = mergeRebaseDeps.pushPlan(cwd, branch);
  if (!plan.ok) return notAuto(plan.error, plan.unblock ?? byHand);
  const remoteTip = remoteRefTip(cwd, plan.data.rawUrl, `refs/heads/${branch}`);
  if (!remoteTip.ok)
    return notAuto(`${plan.data.remote}/${branch} could not be read (${remoteTip.error})`, byHand);
  if (remoteTip.sha !== head)
    return notAuto(
      `${plan.data.remote}/${branch} is at ${remoteTip.sha ? short(remoteTip.sha) : "(absent)"}, not the PR head ${short(head)}`,
      `workit pr status  # once the forge shows the new head: ${again}`,
    );
  const grant = requireGrant(cwd, "push", {
    forge: !plan.data.local,
    target: () => pushTarget(cwd, plan.data.remote),
  });
  if (!grant.allowed)
    return notAuto(
      `pushing needs the push grant as well as merge (${grant.error})`,
      `${grant.unblock}  # then: ${again}; or the user, by hand: ${steps}`,
    );

  const rebased = rebaseOnto(cwd, process.env, onto, input.actor);
  if (!rebased.ok)
    return {
      ok: false,
      code: "conflicts" in rebased ? "blocked" : "failed",
      why: `${branch} was not rebased: ${rebased.error}`,
      unblock: "conflicts" in rebased ? byHand : (rebased.unblock ?? byHand),
      conflicts,
    };
  const after = rebased.data;
  if (!after.rebased) return notAuto(`the rebase onto ${onto} changed nothing`, byHand);
  // A base that moved on to include the PR head fast-forwards the branch onto
  // it: nothing of the PR is left to push, so put the branch back (#928).
  if (after.commits === 0) {
    const restored = git(cwd, ["reset", "--quiet", "--keep", head]);
    if (!restored.ok)
      return {
        ok: false,
        code: "failed",
        why: `${onto} (${short(after.baseSha)}) already contains the PR head ${short(head)}, and ${branch} could not be put back from ${short(after.head)} (${gitError(restored)}); nothing was pushed`,
        unblock: `git reset --keep ${head}  # then: workit pr status`,
        conflicts,
      };
    return notAuto(
      `${onto} (${short(after.baseSha)}) already contains the PR head ${short(head)}, so the rebase left nothing to push; ${branch} is back at ${short(head)}`,
      `workit pr status  # the PR may have landed; if it is still open: ${again}`,
    );
  }
  const pushPlan = mergeRebaseDeps.pushPlan(cwd, branch);
  const pushed = pushPlan.ok
    ? executePush(cwd, pushPlan.data, { forceWithLease: true, expect: head, actor: input.actor })
    : pushPlan;
  if (!pushed.ok)
    return {
      ok: false,
      code: "failed",
      why: `${branch} was rebased onto ${onto} here (${short(head)} -> ${short(after.head)}) but not pushed: ${pushed.error}`,
      unblock: `${pushed.unblock ?? `workit git push --force-with-lease --expect ${head}`}  # then: ${ciWait}, and ${again}`,
      conflicts,
    };
  const next = [ciWait, again];
  return {
    ok: true,
    data: {
      branch,
      onto,
      baseSha: after.baseSha,
      previous: head,
      head: after.head,
      changelog: after.changelogMerged.length ? after.changelogMerged : conflicts,
      rebaseRecorded: after.recorded,
      pushRecorded: pushed.data.recorded,
      next,
    },
    message: `rebased_pushed: ${label} conflicted with ${doc.base} only in ${files}; rebased ${branch} onto ${onto} (${short(head)} -> ${short(after.head)}) keeping both sides' Unreleased entries and pushed it with --force-with-lease; not merged: the new head needs its CI first`,
    unblock: `${ciWait}  # then: ${again}`,
  };
}
