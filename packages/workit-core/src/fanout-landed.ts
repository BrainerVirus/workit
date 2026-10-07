// Has a fanout slice landed? Shared by `fanout status` and `fanout check`, so
// a landed slice is done for both and its dependents stop waiting.
//
// With the forge, the slice branch's PR reads merged. A squash merge never
// makes the branch an ancestor of the trunk, so this is the only reliable
// signal; it holds while the branch has nothing newer than the merged head.
// Without the forge (offline, no gh/glab, no PR yet), git decides:
// - on_trunk: the branch tip is on the trunk and has commits of its own (a
//   merge commit or fast-forward);
// - squash_patch: the branch's change has the same patch-id as one trunk
//   commit (a squash merge that applied without the trunk touching the same
//   lines). Anything else reads as not landed.
import { spawnSync } from "node:child_process";
import { GIT_TIMEOUTS, mergeBase, patchId } from "./git/rev";
import type { ResolvedForge } from "./forge/resolve";
import type { PrRef } from "./forge/types";
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

const isAncestor = (cwd: string, a: string, b: string): boolean =>
  gitRun(cwd, ["merge-base", "--is-ancestor", a, b]).ok;

/** Where a local branch began (its oldest reflog entry), or null. */
export function branchCreatedAt(cwd: string, branch: string): string | null {
  if (!branch || branch.startsWith("-")) return null;
  const log = gitRun(cwd, ["log", "-g", "--format=%H", `refs/heads/${branch}`, "--"]);
  if (!log.ok) return null;
  return log.stdout.trim().split("\n").findLast(Boolean) ?? null;
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

/**
 * Has `slice` landed on the trunk? `head` is the branch tip (null when the
 * branch is gone), `createdFrom` the commit it began at when known (reflog or
 * the worktree ledger row), `parentHead` its dependency branch's tip (or
 * merged head) for a stacked slice.
 */
export function detectLanding(
  ctx: LandingContext,
  slice: Pick<Slice, "branch">,
  input: { head: string | null; createdFrom: string | null; parentHead: string | null },
): SliceLanding {
  const out: SliceLanding = {
    landed: false,
    how: null,
    pr: null,
    landedHead: null,
    forgeError: null,
    note: null,
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
        if (!head || !merged || head === merged || isAncestor(ctx.cwd, head, merged)) {
          return { ...out, landed: true, how: "pr_merged", landedHead: merged ?? head };
        }
        out.note = `#${found.data.number} merged at ${merged.slice(0, 12)}, but ${slice.branch} has newer commits`;
        return out;
      }
    }
  }
  if (!head) return out;
  const fork = mergeBase(ctx.cwd, head, ctx.trunk);
  if (fork === head) {
    // On the trunk: landed only when it has commits of its own.
    const start = input.createdFrom;
    if (start && start !== head && isAncestor(ctx.cwd, start, head))
      return { ...out, landed: true, how: "on_trunk", landedHead: head };
    return out;
  }
  if (!fork) return out;
  const trunkIds = trunkPatchIds(ctx, fork);
  if (trunkIds.size === 0) return out;
  const froms = [fork];
  if (input.parentHead && input.parentHead !== head && isAncestor(ctx.cwd, input.parentHead, head))
    froms.push(input.parentHead);
  for (const from of froms) {
    const id = patchId(ctx.cwd, from, head);
    if (id && trunkIds.has(id))
      return { ...out, landed: true, how: "squash_patch", landedHead: head };
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
