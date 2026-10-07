// `workit fanout status` (G3): one dashboard row per slice, derived from side
// effects only (git, the forge, the ledger), never from what a worker said.
//
// Per slice: whether its branch exists and its head, the age of its last
// commit, its PR and CI state (when the forge answers), the ledger verdict on
// that head, and whether it landed (fanout-landed.ts, squash merges
// included). A slice is STUCK when it started, has not landed, has no
// accepted verdict, and nothing moved for longer than the threshold: no new
// commit or branch update, no ledger row for its branch or slice. The
// threshold is --stuck-after, else the slice's TIMEBOX when it reads as a
// duration, else 30 minutes.
//
// Landable: not landed, an accepted verdict on the current head and, when the
// forge answered, an open PR whose checks pass. The suggested landing order
// walks the plan's order (dependencies first), skips landed slices and keeps
// a slice only once each dependency has landed or comes earlier in the order.
// Without the forge (offline, no gh/glab) the rest still works and says so.
import { checksState, gatingChecks, missingRequired, type ChecksState } from "./forge/report";
import type { ResolvedForge } from "./forge/resolve";
import { checkVerdicts, readLedger, type ReadRow, type VerdictBasis } from "./ledger";
import { sliceLandings } from "./fanout-check";
import {
  branchRef,
  fanoutFail,
  gitRun,
  landingOrder,
  trunkRef,
  type FanoutFile,
  type FanoutResult,
  type Slice,
} from "./fanout";
import type { LandedHow } from "./fanout-landed";

export const DEFAULT_STUCK_MS = 30 * 60_000;

export type SliceState = "landed" | "ready" | "stuck" | "active" | "waiting" | "not_started";

export type SliceStatusRow = {
  id: string;
  branch: string;
  base: string;
  worktree: string;
  dependsOn: string[];
  branchExists: boolean;
  head: string | null;
  lastCommitAt: string | null;
  /** Newest side effect: commit, branch update (reflog) or ledger row. */
  lastActivityAt: string | null;
  idleMinutes: number | null;
  stuckAfterMinutes: number;
  pr: { number: number; url: string; state: string } | null;
  /** passing | failing | pending | none, or unknown without the forge or a PR. */
  ci: ChecksState | "unknown";
  verdict: { accepted: boolean; basis: VerdictBasis; review: string };
  landed: { how: LandedHow; pr: number | null } | null;
  stuck: boolean;
  /** Dependencies that have not landed. */
  waitsFor: string[];
  state: SliceState;
  /** Why it is not landable yet. */
  reasons: string[];
  notes: string[];
};

export type StatusOutcome = {
  name: string;
  trunk: string;
  trunkRef: string | null;
  forge: { available: boolean; error: string | null };
  slices: SliceStatusRow[];
  /** Landable slices in the order to land them. */
  landingOrder: string[];
  /** Not started, every dependency landed (or, stacked, its parent branch exists). */
  spawnable: string[];
  stuck: string[];
  next: string;
  notes: string[];
};

export type StatusOptions = {
  forge: ResolvedForge | null;
  /** Why the forge is not available (shown in notes). */
  forgeError?: string | null;
  stuckAfterMs?: number | null;
  now?: Date;
};

/** A TIMEBOX such as `45 minutes`, `45m`, `2h` or `1.5 hours`, in ms; null otherwise. */
export function timeboxMs(text: string | null): number | null {
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)$/iu.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * (match[2].toLowerCase().startsWith("h") ? 60 : 1);
  return minutes > 0 ? Math.round(minutes * 60_000) : null;
}

const isoOf = (seconds: string): string | null => {
  const value = Number(seconds.trim());
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
};

const newest = (...values: Array<string | null | undefined>): string | null =>
  values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value ?? "")))
    .reduce<string | null>(
      (best, value) => (best === null || Date.parse(value) > Date.parse(best) ? value : best),
      null,
    );

function activity(cwd: string, plan: FanoutFile, slice: Slice, rows: readonly ReadRow[]) {
  const head = branchRef(cwd, slice.branch);
  const commit = head ? isoOf(gitRun(cwd, ["log", "-1", "--format=%ct", head, "--"]).stdout) : null;
  // `refs/heads/<b>@{<unix time>}`: when the local branch last moved.
  const moved = /@\{(\d+)\}/u.exec(
    gitRun(cwd, [
      "log",
      "-g",
      "-1",
      "--date=unix",
      "--format=%gd",
      `refs/heads/${slice.branch}`,
      "--",
    ]).stdout,
  );
  const reflog = moved ? isoOf(moved[1]) : null;
  const ledger = rows
    .filter(
      (row) => row.branch === slice.branch || (row.fanout === plan.name && row.slice === slice.id),
    )
    .map((row) => row.at);
  return {
    head,
    commit,
    last: newest(commit, reflog, ...ledger),
    worktreeCreated: rows.some(
      (row) =>
        row.type === "fanout.worktree.created" &&
        row.fanout === plan.name &&
        row.slice === slice.id,
    ),
  };
}

export function fanoutStatus(
  cwd: string,
  plan: FanoutFile,
  options: StatusOptions,
): FanoutResult<StatusOutcome> {
  const now = options.now ?? new Date();
  const forge = options.forge;
  const trunk = trunkRef(cwd, plan.trunk);
  if (!trunk)
    return fanoutFail(
      "unavailable",
      `trunk ${plan.trunk} does not resolve here`,
      `git fetch origin ${plan.trunk}`,
    );
  const ledger = readLedger(cwd);
  const rows: readonly ReadRow[] = ledger.ok ? ledger.value.rows : [];
  const notes: string[] = [];
  if (!ledger.ok) notes.push(`ledger unreadable (${ledger.error}); verdicts read as missing`);
  if (!forge)
    notes.push(
      `forge unavailable${options.forgeError ? ` (${options.forgeError})` : ""}: PR and CI not shown; landed detection uses git only, so a squash merge may be missed`,
    );

  const tips = new Map(plan.slices.map((slice) => [slice.id, branchRef(cwd, slice.branch)]));
  const landings = sliceLandings(cwd, plan, trunk, tips, rows, forge);
  const byId = new Map(plan.slices.map((slice) => [slice.id, slice]));
  const order = landingOrder(plan.slices);
  const out = new Map<string, SliceStatusRow>();

  for (const id of order) {
    const slice = byId.get(id) as Slice;
    const landing = landings.get(id);
    const seen = activity(cwd, plan, slice, rows);
    const threshold = options.stuckAfterMs ?? timeboxMs(slice.timebox) ?? DEFAULT_STUCK_MS;
    const idle = seen.last ? Math.max(0, now.getTime() - Date.parse(seen.last)) : null;
    const verdict = seen.head ? checkVerdicts(cwd, slice.branch, rows) : null;
    const row: SliceStatusRow = {
      id,
      branch: slice.branch,
      base: slice.base,
      worktree: slice.worktree,
      dependsOn: slice.dependsOn,
      branchExists: seen.head !== null,
      head: seen.head,
      lastCommitAt: seen.commit,
      lastActivityAt: seen.last,
      idleMinutes: idle === null ? null : Math.floor(idle / 60_000),
      stuckAfterMinutes: Math.round(threshold / 60_000),
      pr: landing?.pr
        ? { number: landing.pr.number, url: landing.pr.url, state: landing.pr.state }
        : null,
      ci: "unknown",
      verdict: {
        accepted: verdict?.accepted.accepted ?? false,
        basis: verdict?.current.basis ?? "none",
        review: verdict?.review ?? "unreviewed",
      },
      landed:
        landing?.landed && landing.how
          ? { how: landing.how, pr: landing.pr?.number ?? null }
          : null,
      stuck: false,
      waitsFor: [],
      state: "not_started",
      reasons: [],
      notes: [
        ...(landing?.note ? [landing.note] : []),
        ...(landing?.forgeError ? [`forge: ${landing.forgeError}`] : []),
      ],
    };
    if (forge && landing?.pr && landing.pr.state === "open" && !row.landed) {
      const status = forge.forge.prStatus(landing.pr.number);
      if (status.ok)
        row.ci = checksState(gatingChecks(status.data).checks, missingRequired(status.data));
      else row.notes.push(`forge: ${status.error}`);
    }
    row.waitsFor = slice.dependsOn.filter((dep) => !out.get(dep)?.landed);
    out.set(id, row);
    if (row.landed) {
      row.state = "landed";
      continue;
    }
    const started = row.branchExists || seen.worktreeCreated;
    if (!row.branchExists) row.reasons.push("no branch yet");
    if (!row.verdict.accepted)
      row.reasons.push(
        `verdict ${row.verdict.basis === "none" ? "missing" : row.verdict.basis} on the current head`,
      );
    if (forge && row.branchExists) {
      if (!row.pr) row.reasons.push("no PR");
      else if (row.pr.state !== "open") row.reasons.push(`PR ${row.pr.state}`);
      else if (row.ci === "failing" || row.ci === "pending") row.reasons.push(`CI ${row.ci}`);
    }
    row.stuck = started && !row.verdict.accepted && idle !== null && idle > threshold;
    if (row.stuck) row.reasons.push(`no activity for ${row.idleMinutes} min`);
  }

  // Landing order: landable slices whose dependencies landed or land earlier.
  const suggested: string[] = [];
  for (const id of order) {
    const row = out.get(id) as SliceStatusRow;
    if (row.landed || row.reasons.length) continue;
    if (row.waitsFor.every((dep) => suggested.includes(dep))) suggested.push(id);
  }
  const spawnable: string[] = [];
  for (const id of order) {
    const row = out.get(id) as SliceStatusRow;
    if (row.landed) continue;
    const parent = plan.slices.find((other) => other.branch === row.base);
    if (suggested.includes(id)) row.state = "ready";
    else if (row.stuck) row.state = "stuck";
    // Work on a branch is in progress even while its dependency has not landed.
    else if (row.branchExists) row.state = "active";
    else if (
      row.waitsFor.length === 0 ||
      (parent && row.waitsFor.length === 1 && out.get(parent.id)?.branchExists)
    ) {
      const created = rows.some(
        (candidate) =>
          candidate.type === "fanout.worktree.created" &&
          candidate.fanout === plan.name &&
          candidate.slice === id,
      );
      row.state = created ? "active" : "not_started";
      if (!created) spawnable.push(id);
    } else row.state = "waiting";
    if (row.waitsFor.length && !suggested.includes(id))
      row.reasons.push(`waits for ${row.waitsFor.join(", ")}`);
  }
  const stuck = order.filter((id) => out.get(id)?.stuck);
  const next = stuck.length
    ? `replace ${stuck.join(", ")}: stop the worker, then workit fanout worktree release ${stuck[0]} (records git status first) and respawn it in MODE: resume`
    : suggested.length
      ? `land in this order: ${suggested.join(", ")} (workit fanout check first; workit pr merge each)`
      : spawnable.length
        ? `spawn ${spawnable.join(", ")} (workit fanout worktree create <slice> on hosts without native worktrees)`
        : order.every((id) => out.get(id)?.landed)
          ? "every slice has landed"
          : "wait for workers, then workit fanout status again";
  return {
    ok: true,
    data: {
      name: plan.name,
      trunk: plan.trunk,
      trunkRef: trunk,
      forge: { available: forge !== null, error: forge ? null : (options.forgeError ?? null) },
      slices: order.map((id) => out.get(id) as SliceStatusRow),
      landingOrder: suggested,
      spawnable,
      stuck,
      next,
      notes,
    },
  };
}
