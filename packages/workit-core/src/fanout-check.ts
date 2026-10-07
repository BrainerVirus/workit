// `workit fanout check` (G2): the fan-in gate over a recorded fanout plan.
//
// For each slice branch it reads what git says, never what a worker reported:
// - scope: `git diff --name-only <base>...<branch>` against the slice's
//   manifest (its scope and owns, minus files another slice owns); any other
//   file is an out-of-scope edit;
// - trunk: `git merge-tree --write-tree` of the branch with the trunk;
// - siblings: the same merge between every pair of slice branches, so two
//   PRs that would conflict once the first lands are caught before either
//   does. A pairwise conflict is charged to the slice that lands later; the
//   earlier one stays landable.
// The landing order puts dependencies first, then the plan's order. A slice
// is ready when none of the above fired and every slice it depends on is
// ready. Verdicts are reported (`workit ledger check`) but gated by
// `workit pr merge`, not here. Refs are read as they are locally: fetch first.
import { checkVerdicts, readLedger, type ReadRow } from "./ledger";
import {
  FANOUT_VERSION,
  branchRef,
  fanoutFail,
  gitRun,
  inScope,
  landingOrder,
  nulList,
  trunkRef,
  type FanoutFile,
  type FanoutResult,
  type Slice,
} from "./fanout";

export type SliceStatus = "ready" | "blocked";

export type SliceCheck = {
  id: string;
  branch: string;
  head: string | null;
  base: string;
  status: SliceStatus;
  changed: number;
  outOfScope: string[];
  trunkConflicts: string[];
  siblingConflicts: Array<{ with: string; paths: string[] }>;
  waitsFor: string[];
  verdict: { accepted: boolean; basis: string };
  reasons: string[];
};

export type SiblingConflict = {
  /** Lands first in the landing order. */
  first: string;
  /** Lands second; it carries the conflict. */
  second: string;
  paths: string[];
  /** The two branches name one file with different case (one file on macOS and Windows). */
  caseOnly?: true;
  resolution: string;
};

export type CheckOutcome = {
  name: string;
  trunk: string;
  trunkRef: string;
  ready: boolean;
  slices: SliceCheck[];
  conflicts: SiblingConflict[];
  landingOrder: string[];
  next: string;
  notes: string[];
};

const SAFE = (value: string | null): value is string => Boolean(value) && !value?.startsWith("-");

/** Paths both sides change incompatibly, [] when clean, or an error. */
function mergeConflicts(cwd: string, a: string, b: string): string[] | { error: string } {
  const run = gitRun(cwd, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    a,
    b,
  ]);
  if (run.status === 0) return [];
  if (run.status === 1) return [...new Set(nulList(run.stdout).slice(1))];
  const first = run.stderr.trim().split("\n")[0] || `git merge-tree exited ${run.status}`;
  return {
    error: /write-tree|usage: git merge-tree/u.test(run.stderr)
      ? `${first} (needs git >= 2.38 for merge-tree --write-tree)`
      : first,
  };
}

const isAncestor = (cwd: string, a: string, b: string): boolean =>
  gitRun(cwd, ["merge-base", "--is-ancestor", a, b]).ok;

export function checkFanout(
  cwd: string,
  plan: FanoutFile,
  options: { only?: readonly string[]; trunkRef?: string | null } = {},
): FanoutResult<CheckOutcome> {
  const unknown = (options.only ?? []).filter((id) => !plan.slices.some((s) => s.id === id));
  if (unknown.length)
    return fanoutFail(
      "invalid_input",
      `${unknown.join(", ")}: not a slice of fanout ${plan.name}`,
      `slices: ${plan.slices.map((slice) => slice.id).join(", ")}`,
    );
  const trunk = options.trunkRef ?? trunkRef(cwd, plan.trunk);
  if (!SAFE(trunk) || !resolves(cwd, trunk))
    return fanoutFail(
      "unavailable",
      `trunk ${options.trunkRef ?? plan.trunk} does not resolve here`,
      `git fetch, or pass --base <ref>`,
    );
  const order = landingOrder(plan.slices);
  const byId = new Map(plan.slices.map((slice) => [slice.id, slice]));
  const tips = new Map(plan.slices.map((slice) => [slice.id, branchRef(cwd, slice.branch)]));
  const ledger = readLedger(cwd);
  const rows: readonly ReadRow[] = ledger.ok ? ledger.value.rows : [];

  const checks = new Map<string, SliceCheck>();
  const changedBy = new Map<string, string[]>();
  for (const slice of plan.slices)
    checks.set(slice.id, inspect(cwd, plan, slice, trunk, tips, rows, changedBy));

  // Pairwise siblings: skip a pair where one contains the other (a stacked child).
  const conflicts: SiblingConflict[] = [];
  for (let i = 0; i < order.length; i += 1)
    for (let j = i + 1; j < order.length; j += 1) {
      const first = order[i];
      const second = order[j];
      const a = tips.get(first);
      const b = tips.get(second);
      if (!a || !b || isAncestor(cwd, a, b) || isAncestor(cwd, b, a)) continue;
      const check = checks.get(second) as SliceCheck;
      const theirs = new Map(
        (changedBy.get(first) ?? []).map((file) => [file.toLowerCase(), file]),
      );
      const cased = (changedBy.get(second) ?? []).flatMap((file) => {
        const other = theirs.get(file.toLowerCase());
        return other !== undefined && other !== file ? [`${other} ~ ${file}`] : [];
      });
      if (cased.length) {
        conflicts.push({
          first,
          second,
          paths: cased,
          caseOnly: true,
          resolution: `use ${first}'s spelling on ${second} (git mv), then workit fanout check`,
        });
        check.siblingConflicts.push({ with: first, paths: cased });
        check.reasons.push(`differs only in case from ${first}: ${cased.join(", ")}`);
      }
      const result = mergeConflicts(cwd, a, b);
      if (!Array.isArray(result)) {
        check.reasons.push(`cannot merge with ${first}: ${result.error}`);
        continue;
      }
      if (result.length === 0) continue;
      const related = byId.get(second)?.dependsOn.includes(first);
      conflicts.push({
        first,
        second,
        paths: result,
        resolution: related
          ? `rebase ${second} onto ${byId.get(first)?.branch} (its dependency), then workit fanout check`
          : `land ${first} first, then rebase ${second} onto ${plan.trunk} and run workit fanout check; or make ${second} depend on ${first}`,
      });
      check.siblingConflicts.push({ with: first, paths: result });
      check.reasons.push(`conflicts with ${first} on ${result.join(", ")}`);
    }

  for (const id of order) {
    const check = checks.get(id) as SliceCheck;
    check.waitsFor = (byId.get(id)?.dependsOn ?? []).filter(
      (dep) => checks.get(dep)?.status !== "ready",
    );
    if (check.waitsFor.length) check.reasons.push(`waits for ${check.waitsFor.join(", ")}`);
    check.status = check.reasons.length ? "blocked" : "ready";
  }

  const selected = options.only?.length ? new Set(options.only) : null;
  const slices = order
    .filter((id) => !selected || selected.has(id))
    .map((id) => checks.get(id) as SliceCheck);
  const ready = slices.every((check) => check.status === "ready");
  const blocked = slices.find((check) => check.status === "blocked");
  const notes =
    plan.v === FANOUT_VERSION
      ? []
      : [
          `plan file version ${plan.v} is not ${FANOUT_VERSION}; read leniently (re-plan to rewrite it)`,
        ];
  const next = blocked
    ? unblockFor(blocked, plan)
    : `land in this order: ${slices.map((check) => check.id).join(", ")} (workit pr merge each once verified; stacked slices with workit stack land)`;
  return {
    ok: true,
    data: {
      name: plan.name,
      trunk: plan.trunk,
      trunkRef: trunk,
      ready,
      slices,
      conflicts: conflicts.filter(
        (conflict) => !selected || selected.has(conflict.first) || selected.has(conflict.second),
      ),
      landingOrder: order,
      notes,
      next,
    },
  };
}

const resolves = (cwd: string, ref: string): boolean =>
  gitRun(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).ok;

function inspect(
  cwd: string,
  plan: FanoutFile,
  slice: Slice,
  trunk: string,
  tips: ReadonlyMap<string, string | null>,
  rows: readonly ReadRow[],
  changedBy: Map<string, string[]>,
): SliceCheck {
  const head = tips.get(slice.id) ?? null;
  const check: SliceCheck = {
    id: slice.id,
    branch: slice.branch,
    head,
    base: slice.base,
    status: "blocked",
    changed: 0,
    outOfScope: [],
    trunkConflicts: [],
    siblingConflicts: [],
    waitsFor: [],
    verdict: { accepted: false, basis: "missing" },
    reasons: [],
  };
  if (!head) {
    check.reasons.push(`branch ${slice.branch} not found (not started, landed, or not fetched)`);
    return check;
  }
  const parent = plan.slices.find((other) => other.branch === slice.base);
  const baseRef =
    slice.base === plan.trunk
      ? trunk
      : parent
        ? (tips.get(parent.id) ?? null)
        : branchRef(cwd, slice.base);
  if (!SAFE(baseRef)) {
    check.reasons.push(`base ${slice.base} not found`);
    return check;
  }
  const diff = gitRun(cwd, ["diff", "--name-only", "--no-renames", "-z", `${baseRef}...${head}`]);
  if (!diff.ok) {
    check.reasons.push(`cannot diff ${slice.base}...${slice.branch}: ${diff.stderr.trim()}`);
    return check;
  }
  const changed = nulList(diff.stdout);
  changedBy.set(slice.id, changed);
  check.changed = changed.length;
  if (changed.length === 0) check.reasons.push(`no changes beyond ${slice.base}`);
  check.outOfScope = changed.filter((file) => !inScope(plan, slice, file)).toSorted();
  if (check.outOfScope.length)
    check.reasons.push(`edits outside its scope: ${check.outOfScope.join(", ")}`);
  const trunkResult = mergeConflicts(cwd, trunk, head);
  if (Array.isArray(trunkResult)) {
    check.trunkConflicts = trunkResult;
    if (trunkResult.length)
      check.reasons.push(`conflicts with ${plan.trunk} on ${trunkResult.join(", ")}`);
  } else check.reasons.push(`cannot merge with ${plan.trunk}: ${trunkResult.error}`);
  const verdict = checkVerdicts(cwd, slice.branch, rows);
  check.verdict = { accepted: verdict.accepted.accepted, basis: verdict.current.basis };
  return check;
}

function unblockFor(check: SliceCheck, plan: FanoutFile): string {
  if (!check.head)
    return `start or fetch ${check.branch}, then workit fanout check; if it landed, re-plan without slice ${check.id}`;
  if (check.outOfScope.length)
    return `move ${check.outOfScope.join(", ")} off ${check.branch} (a follow-up slice), or widen slice ${check.id}'s scope with workit fanout plan, then workit fanout check`;
  if (check.trunkConflicts.length)
    return `rebase ${check.branch} onto ${plan.trunk} and resolve ${check.trunkConflicts.join(", ")}, then workit fanout check`;
  if (check.siblingConflicts.length) {
    const first = check.siblingConflicts[0].with;
    return `land ${first} first, then rebase ${check.branch} onto ${plan.trunk} and run workit fanout check`;
  }
  if (check.waitsFor.length) return `unblock ${check.waitsFor.join(", ")} first`;
  return check.reasons[0] ?? "workit fanout check";
}
