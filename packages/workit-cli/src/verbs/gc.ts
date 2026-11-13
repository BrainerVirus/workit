// `workit gc`: bounded task state. Compacts long task event logs into a
// checkpoint plus their recent events (never losing the latest state),
// removes unreferenced candidate blobs and crashed writers' temp files, and
// prunes `workit check` log blobs (LOG_RETENTION). A 2.x `.workit/recovery`
// directory left by migration is only reported unless `--prune-recovery --yes`.
// `--dry-run` is read-only.
//
// `workit gc --worktrees [--apply]` (#653) instead lists what finished
// changes left on disk: merged clean worktrees in Workit's places, stale
// registrations, merged branches whose remote is gone. Dry run unless --apply.
//
// `workit gc --branches [--apply]` (#835) lists local branches whose work is
// on the trunk (a merged PR at the tip, `git cherry`, a squash proof) and
// deletes them with --apply; see core/cleanup.ts sweepBranches.
//
// Every form refuses an argument it does not know (exit 2), so a caller built
// for an older or newer CLI never falls through to the task-store gc.
import { progressFor } from "../progress";
import { LOG_RETENTION, pruneCheckLogs } from "@workit-dev/core/src/checks";
import { TaskStore } from "@workit-dev/core/src/core/task-store";
import { emit, fail, ok, type Io } from "../output";
import { workspaceRootFor } from "../task";
import {
  sweepBranches,
  sweepWorktrees,
  type BranchForge,
  type BranchSweep,
  type WorktreeSweep,
} from "@workit-dev/core/src/core/cleanup";
import { resolveForge } from "@workit-dev/core/src/forge/resolve";
import { actorFromEnv } from "@workit-dev/core/src/ledger";
import { forgeDeps } from "./forge-common";

/** The usage line (the registry's gc entry carries the same text). */
const GC_USAGE =
  "workit gc [--dry-run] [--prune-recovery --yes] | --worktrees [--apply] | --branches [--apply]";

/** Bound on reaching the forge for the merged-PR check. */
const FORGE_BUDGET_MS = 15_000;

/** How `gc --branches` reaches the forge; tests swap it for a fake. */
export const gcDeps = {
  forge: (io: Io): BranchForge | { skipped: string } => {
    const resolved = resolveForge(io.cwd, {
      env: io.env,
      runner: forgeDeps.runner,
      now: forgeDeps.now,
      deadline: forgeDeps.now() + FORGE_BUDGET_MS,
    });
    return resolved.ok ? resolved.data : { skipped: resolved.error };
  },
};

const ALLOWED: Record<"worktrees" | "branches" | "store", readonly string[]> = {
  worktrees: ["--worktrees", "--apply", "--dry-run", "--json"],
  branches: ["--branches", "--apply", "--dry-run", "--json"],
  store: ["--dry-run", "--prune-recovery", "--yes", "--json"],
};

const branchLines = (data: BranchSweep): string[] => {
  const deleted = new Set(data.deleted);
  return [
    `workit gc --branches${data.apply ? "" : " (dry run; --apply deletes)"}`,
    ...(data.forgeSkipped ? [`merged-PR check skipped: ${data.forgeSkipped}`] : []),
    ...(data.deletable.length ? [] : ["nothing to delete"]),
    ...data.deletable.map(
      (entry) =>
        `${data.apply ? (deleted.has(entry.name) ? "deleted" : "not deleted") : "would delete"} branch ${entry.name}: ${entry.reason}`,
    ),
    ...data.kept.map((entry) => `kept branch ${entry.name}: ${entry.reason}`),
    ...data.notes,
    ...(data.recorded && "error" in data.recorded
      ? [`ledger: not recorded (${data.recorded.error})`]
      : []),
  ];
};

const megabytes = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

const sweepLines = (data: WorktreeSweep): string[] => {
  const verb = data.apply ? "removed" : "would remove";
  const done = new Set(data.removed);
  const deleted = new Set(data.deletedBranches);
  return [
    `workit gc --worktrees${data.apply ? "" : " (dry run; --apply removes)"}`,
    ...(data.removable.length || data.goneBranches.length ? [] : ["nothing to remove"]),
    ...data.removable.map(
      (entry) =>
        `${data.apply && !done.has(entry.path) ? "not removed" : verb} ${entry.path}${entry.branch ? ` [${entry.branch}]` : ""}: ${entry.reason}, ${megabytes(entry.bytes)} MB`,
    ),
    ...data.goneBranches.map(
      (entry) =>
        `${data.apply && !deleted.has(entry.name) ? "not deleted" : data.apply ? "deleted" : "would delete"} branch ${entry.name}: remote gone, ${entry.reason}`,
    ),
    ...data.removedScratch.map((dir) => `removed worker scratch ${dir}`),
    ...data.removedDirs.map((dir) => `removed empty ${dir}`),
    ...data.kept.map(
      (entry) =>
        `kept ${entry.path || `branch ${entry.branch}`}${entry.path && entry.branch ? ` [${entry.branch}]` : ""}: ${entry.reason}`,
    ),
    ...data.notes,
    ...(data.recorded && "error" in data.recorded
      ? [`ledger: not recorded (${data.recorded.error})`]
      : []),
  ];
};

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--worktrees") && argv.includes("--branches"))
    return emit(io, fail("invalid_input", `pass --worktrees or --branches, not both: ${GC_USAGE}`));
  const form = argv.includes("--worktrees")
    ? "worktrees"
    : argv.includes("--branches")
      ? "branches"
      : "store";
  const unknown = argv.find((arg) => !ALLOWED[form].includes(arg));
  if (unknown) return emit(io, fail("invalid_input", `unknown argument ${unknown}: ${GC_USAGE}`));
  if (form !== "store" && argv.includes("--apply") && argv.includes("--dry-run"))
    return emit(io, fail("invalid_input", "pass --apply or --dry-run, not both"));
  if (form === "branches") {
    const reached = gcDeps.forge(io);
    const forge = "skipped" in reached ? null : reached;
    const sweep = progressFor(io).runSync(
      "Sweeping branches",
      () =>
        sweepBranches(io.cwd, {
          apply: argv.includes("--apply"),
          actor: actorFromEnv(io.env),
          forge,
          ...("skipped" in reached ? { forgeSkipped: reached.skipped } : {}),
        }),
      () => "done",
    );
    return emit(io, ok(sweep), branchLines);
  }
  if (form === "worktrees") {
    const sweep = progressFor(io).runSync(
      "Sweeping worktrees",
      () =>
        sweepWorktrees(io.cwd, {
          apply: argv.includes("--apply"),
          actor: actorFromEnv(io.env),
          env: io.env,
        }),
      () => "done",
    );
    return emit(io, ok(sweep), sweepLines);
  }
  const dryRun = argv.includes("--dry-run");
  const pruneRecovery = argv.includes("--prune-recovery");
  if (pruneRecovery && !dryRun && !argv.includes("--yes"))
    return emit(
      io,
      fail("blocked", "--prune-recovery deletes the 2.x recovery copies; confirm with --yes", {
        unblock: "workit gc --prune-recovery --yes",
      }),
    );
  const store = new TaskStore(workspaceRootFor({ cwd: io.cwd }));
  const location = store.location();
  const logs = location.ok ? pruneCheckLogs(location.data.dir, { dryRun }) : null;
  const result = progressFor(io).runSync(
    "Collecting garbage",
    () => store.collectGarbage({ dryRun, pruneRecovery }),
    (r) => (r.ok ? "done" : "failed"),
  );
  if (!result.ok)
    return emit(
      io,
      fail(result.code === "busy" ? "busy" : "failed", `${result.code}: ${result.error}`, {
        data: { code: result.code, details: result.details },
        ...(result.code === "busy" ? { unblock: "retry `workit gc`" } : {}),
      }),
    );
  return emit(io, ok({ ...result.data, logs }), (data) => {
    const verb = data.dryRun ? "would" : "did";
    const { compacted, blobs, legacyRecovery } = data;
    return [
      `workit gc${data.dryRun ? " (dry run)" : ""}`,
      `task logs: ${verb} compact ${compacted.tasks.length} (${compacted.eventsFolded} events folded${data.dryRun ? "" : `, ${megabytes(compacted.bytesBefore)} → ${megabytes(compacted.bytesAfter)} MB`})${data.retried.length ? `; changed meanwhile, next run: ${data.retried.join(", ")}` : ""}${data.failed.length ? `; failed ${data.failed.join(", ")}` : ""}`,
      `candidate blobs: ${verb} remove ${blobs.removed} (${megabytes(blobs.removedBytes)} MB), kept ${blobs.kept}`,
      `temporary files: ${verb} remove ${data.temporary.removed}`,
      ...(legacyRecovery
        ? [
            legacyRecovery.removed
              ? `2.x recovery copies: removed ${legacyRecovery.path} (${legacyRecovery.files} files, ${megabytes(legacyRecovery.bytes)} MB)`
              : `2.x recovery copies: ${legacyRecovery.path} holds ${legacyRecovery.files} files (${megabytes(legacyRecovery.bytes)} MB) no longer used; delete with \`workit gc --prune-recovery --yes\``,
          ]
        : []),
      ...(data.logs
        ? [
            `check logs: ${verb} remove ${data.logs.removed} (${megabytes(data.logs.removedBytes)} MB), kept ${data.logs.kept} (newest ${LOG_RETENTION.maxCount}, ≤${LOG_RETENTION.maxAgeMs / 86_400_000} days)`,
          ]
        : []),
    ];
  });
}
