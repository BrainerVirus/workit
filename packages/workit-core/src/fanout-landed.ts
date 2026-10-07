// Has a fanout slice landed? Shared by `fanout status` and `fanout check`, so
// a landed slice is done for both and its dependents stop waiting.
//
// With the forge, the slice branch's PR reads merged. A squash merge never
// makes the branch an ancestor of the trunk, so this is the only reliable
// signal; it holds while the branch has nothing newer than the merged head.
// Without the forge (offline, no gh/glab, no PR yet), git decides:
// - on_trunk: the branch tip is on the trunk and its reflog proves commits of
//   its own (a commit, cherry-pick or rebase made on it, inside start..head);
//   a branch only fast-forwarded to a newer trunk or parent has none;
// - squash_patch: the branch's change has the same patch-id as one trunk
//   commit (a squash merge that applied without the trunk touching the same
//   lines). Anything else reads as not landed.
// A merged PR whose branch is gone counts only when the ledger links that
// branch to this slice: a worktree row made under this plan's hash, or a row
// recorded on its merged head since this hash was planned. A reused branch
// name from older work, or an older plan of the same name, never links.
// A landing whose changed paths read on the trunk exactly as before it (a
// revert) is not landed; the note says so.
// The forge is asked through a breaker: after the first unavailable answer
// (gh/glab missing, not logged in, timed out) it is not asked again in the
// same run, and git decides the rest.
import { spawnSync } from "node:child_process";
import { GIT_TIMEOUTS, hasCommit, mergeBase, patchId } from "./git/rev";
import type { ResolvedForge } from "./forge/resolve";
import type { ForgeResult, PrRef } from "./forge/types";
import { gitRun, type Slice } from "./fanout";

export type LandedHow = "pr_merged" | "on_trunk" | "squash_patch";

export type SliceLanding = {
  landed: boolean;
  how: LandedHow | null;
  /** The slice's PR when the forge was asked and has one (open, closed or merged). */
  pr: PrRef | null;
  /** The merged head: a stacked child's diff base once the branch is gone. */
  landedHead: string | null;
  /** Why the forge could not answer for this slice; null when it did or was not asked. */
  forgeError: string | null;
  note: string | null;
};

export type LandingContext = {
  cwd: string;
  /** The trunk ref (e.g. refs/remotes/origin/main). */
  trunk: string;
  forge: ResolvedForge | null;
  /** Trunk patch-ids per fork point, filled lazily. */
  cache?: Map<string, Set<string>>;
};

export type ForgeBreaker = {
  /** The forge whose calls stop after the first unavailable answer; null when there is none. */
  forge: ResolvedForge | null;
  /** Why it went down during this run, else null. */
  down: () => string | null;
};

/**
 * Wrap the forge so a missing, logged-out or hanging gh/glab costs one call
 * per run, not one timeout per slice: after the first `unavailable` answer
 * every later call fails at once with the same error.
 */
export function forgeBreaker(resolved: ResolvedForge | null): ForgeBreaker {
  if (!resolved) return { forge: null, down: () => null };
  let tripped: string | null = null;
  const guard =
    <A extends unknown[], T>(call: (...args: A) => ForgeResult<T>) =>
    (...args: A): ForgeResult<T> => {
      if (tripped) return { ok: false, code: "unavailable", error: tripped };
      const result = call(...args);
      if (!result.ok && result.code === "unavailable") tripped = result.error;
      return result;
    };
  const inner = resolved.forge;
  const forge = Object.create(inner) as typeof inner;
  forge.findPr = guard(inner.findPr.bind(inner));
  forge.prStatus = guard(inner.prStatus.bind(inner));
  return { forge: { ...resolved, forge }, down: () => tripped };
}

const isAncestor = (cwd: string, a: string, b: string): boolean =>
  gitRun(cwd, ["merge-base", "--is-ancestor", a, b]).ok;

/** Where a local branch began (its oldest reflog entry), or null. */
export function branchCreatedAt(cwd: string, branch: string): string | null {
  if (!branch || branch.startsWith("-")) return null;
  const log = gitRun(cwd, ["log", "-g", "--format=%H", `refs/heads/${branch}`, "--"]);
  if (!log.ok) return null;
  return log.stdout.trim().split("\n").findLast(Boolean) ?? null;
}

/**
 * Does the branch's reflog show a commit made on it inside `start..head`?
 * A commit, cherry-pick or rebased pick counts; a fast-forward, reset or
 * branch creation does not, and neither does a rebase that only moved it.
 */
export function hasOwnCommits(
  cwd: string,
  branch: string,
  start: string | null,
  head: string,
): boolean {
  if (!branch || branch.startsWith("-")) return false;
  const log = gitRun(cwd, ["log", "-g", "--format=%H%x00%gs", `refs/heads/${branch}`, "--"]);
  if (!log.ok) return false;
  for (const line of log.stdout.split("\n")) {
    const [sha, subject = ""] = line.split("\0");
    if (!sha) continue;
    const made =
      /^(?:commit(?: \((?:initial|amend)\))?|cherry-pick|rebase(?: -i)? \(pick\)):/u.test(subject);
    const onto = /^rebase(?: -i)? \(finish\): \S+ onto ([0-9a-f]+)/u.exec(subject)?.[1];
    if (!made && !(onto && !sha.startsWith(onto) && !onto.startsWith(sha))) continue;
    if (sha !== head && !isAncestor(cwd, sha, head)) continue;
    if (start && (sha === start || isAncestor(cwd, sha, start))) continue;
    return true;
  }
  return false;
}

/**
 * The landing was undone: every path the change touched reads on the trunk
 * exactly as before it (`git revert`, or a manual undo).
 */
function reverted(cwd: string, trunk: string, landedHead: string, start: string | null): boolean {
  const fork = mergeBase(cwd, landedHead, trunk);
  if (fork && fork !== landedHead) return unchangedSince(cwd, fork, landedHead, trunk);
  // On the trunk already (merge or fast-forward): compare with where it began.
  const before =
    start && start !== landedHead && isAncestor(cwd, start, landedHead)
      ? start
      : gitRun(cwd, ["rev-parse", "--verify", "-q", `${landedHead}^1`]).stdout.trim();
  return before ? unchangedSince(cwd, before, landedHead, trunk) : false;
}

function unchangedSince(cwd: string, before: string, after: string, trunk: string): boolean {
  const paths = gitRun(cwd, ["diff", "--name-only", "--no-renames", "-z", before, after]);
  const files = paths.ok ? paths.stdout.split("\0").filter(Boolean) : [];
  if (files.length === 0) return false;
  return gitRun(cwd, ["diff", "--quiet", before, trunk, "--", ...files]).ok;
}

const TRUNK_SCAN = 500;

/** Stable patch-ids of the trunk's own commits since `fork` (same pinned diff options as patchId). */
function trunkPatchIds(ctx: LandingContext, fork: string): Set<string> {
  const cache = (ctx.cache ??= new Map());
  const known = cache.get(fork);
  if (known) return known;
  const ids = new Set<string>();
  const log = gitRun(ctx.cwd, [
    "log",
    "--no-merges",
    `--max-count=${TRUNK_SCAN}`,
    "-p",
    "--format=commit %H",
    "-U3",
    "--diff-algorithm=myers",
    "--indent-heuristic",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${fork}..${ctx.trunk}`,
    "--",
  ]);
  if (log.ok && log.stdout.trim()) {
    const run = spawnSync("git", ["patch-id", "--stable"], {
      cwd: ctx.cwd,
      input: log.stdout,
      encoding: "utf8",
      timeout: GIT_TIMEOUTS.local,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of (run.stdout ?? "").split("\n")) {
      const id = line.trim().split(/\s+/u)[0];
      if (id) ids.add(id);
    }
  }
  cache.set(fork, ids);
  return ids;
}

/** The ledger links `branch` to this slice: a worktree row, or a row recorded on `head`. */
function linked(
  rows: readonly Record<string, unknown>[],
  input: Pick<LandingInput, "fanout" | "since" | "planHash">,
  slice: Pick<Slice, "id" | "branch">,
  head: string | null,
): boolean {
  // Only rows from this run of the fanout: a plan of the same name made
  // earlier, or re-planned with other content, must not lend its merged PRs.
  const since = input.since ? Date.parse(input.since) : Number.NaN;
  const recent = (row: Record<string, unknown>) =>
    Number.isNaN(since) || Date.parse(String(row.at)) >= since;
  return rows.some((row) => {
    if (
      row.type === "fanout.worktree.created" &&
      row.fanout === input.fanout &&
      row.slice === slice.id
    )
      // A row from before plan hashes falls back to its time.
      return typeof row.planHash === "string" && input.planHash
        ? row.planHash === input.planHash
        : recent(row);
    return recent(row) && head !== null && row.branch === slice.branch && row.head === head;
  });
}

export type LandingInput = {
  /** The branch tip; null when the branch is gone. */
  head: string | null;
  /** The commit it began at when known (reflog or the worktree ledger row). */
  createdFrom: string | null;
  /** Its dependency branch's tip (or merged head) for a stacked slice. */
  parentHead: string | null;
  fanout: string;
  /** When this plan content was first recorded (FanoutFile.hashSince): older rows do not link. */
  since: string | null;
  /** The plan's content hash: worktree rows link only under the same one. */
  planHash: string | null;
  rows: readonly Record<string, unknown>[];
};

/** Has `slice` landed on the trunk? */
export function detectLanding(
  ctx: LandingContext,
  slice: Pick<Slice, "id" | "branch">,
  input: LandingInput,
): SliceLanding {
  const out: SliceLanding = {
    landed: false,
    how: null,
    pr: null,
    landedHead: null,
    forgeError: null,
    note: null,
  };
  const landed = (how: LandedHow, landedHead: string): SliceLanding => {
    if (
      !hasCommit(ctx.cwd, landedHead) ||
      !reverted(ctx.cwd, ctx.trunk, landedHead, input.createdFrom)
    )
      return { ...out, landed: true, how, landedHead };
    return {
      ...out,
      note: `landed (${how}${out.pr ? ` #${out.pr.number}` : ""}), then reverted on the trunk: its paths read as before it`,
    };
  };
  const { head } = input;
  if (ctx.forge) {
    const found = ctx.forge.forge.findPr(slice.branch, {
      owner: ctx.forge.headRepo.split("/")[0] ?? null,
      projectId: ctx.forge.headProjectId,
      sha: head,
    });
    if (!found.ok) out.forgeError = found.error;
    else if (found.data) {
      out.pr = found.data;
      if (found.data.state === "merged") {
        const merged = found.data.headSha;
        const label = `#${found.data.number}`;
        if (!head) {
          if (!linked(input.rows, input, slice, merged)) {
            out.pr = null;
            out.note = `${slice.branch} is gone; merged ${label} is not linked to this slice in the ledger (an older branch of the same name?)`;
            return out;
          }
          return merged ? landed("pr_merged", merged) : { ...out, landed: true, how: "pr_merged" };
        }
        if (!merged || head === merged || isAncestor(ctx.cwd, head, merged))
          return landed("pr_merged", merged ?? head);
        out.note = isAncestor(ctx.cwd, merged, head)
          ? `${label} merged at ${merged.slice(0, 12)}; ${slice.branch} is ahead of it with newer commits`
          : `${label} merged at ${merged.slice(0, 12)}; ${slice.branch} has diverged from it (rewritten after the merge)`;
        return out;
      }
    }
  }
  if (!head) return out;
  const fork = mergeBase(ctx.cwd, head, ctx.trunk);
  if (fork === head) {
    // On the trunk: landed only when commits were made on the branch itself.
    return hasOwnCommits(ctx.cwd, slice.branch, input.createdFrom, head)
      ? landed("on_trunk", head)
      : out;
  }
  if (!fork) return out;
  const trunkIds = trunkPatchIds(ctx, fork);
  if (trunkIds.size === 0) return out;
  const froms = [fork];
  if (input.parentHead && input.parentHead !== head && isAncestor(ctx.cwd, input.parentHead, head))
    froms.push(input.parentHead);
  for (const from of froms) {
    const id = patchId(ctx.cwd, from, head);
    if (id && trunkIds.has(id)) return landed("squash_patch", head);
  }
  return out;
}

/** The commit a slice branch began at: its reflog, else `fanout worktree create`'s ledger row. */
export function sliceStart(
  cwd: string,
  rows: readonly Record<string, unknown>[],
  fanout: string,
  slice: Pick<Slice, "id" | "branch">,
): string | null {
  const reflog = branchCreatedAt(cwd, slice.branch);
  if (reflog) return reflog;
  const row = rows.findLast(
    (candidate) =>
      candidate.type === "fanout.worktree.created" &&
      candidate.fanout === fanout &&
      candidate.slice === slice.id &&
      typeof candidate.baseSha === "string",
  );
  return (row?.baseSha as string | undefined) ?? null;
}
