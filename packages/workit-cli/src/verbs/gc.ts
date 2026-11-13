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
import { progressFor } from "../progress";
import { LOG_RETENTION, pruneCheckLogs } from "@workit-dev/core/src/checks";
import { TaskStore } from "@workit-dev/core/src/core/task-store";
import { emit, fail, ok, type Io } from "../output";
import { workspaceRootFor } from "../task";
import { sweepWorktrees, type WorktreeSweep } from "@workit-dev/core/src/core/cleanup";
import { actorFromEnv } from "@workit-dev/core/src/ledger";

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
  if (argv.includes("--worktrees")) {
    const unknown = argv.find(
      (arg) => !["--worktrees", "--apply", "--dry-run", "--json"].includes(arg),
    );
    if (unknown)
      return emit(
        io,
        fail("invalid_input", `unknown argument ${unknown}: workit gc --worktrees [--apply]`),
      );
    if (argv.includes("--apply") && argv.includes("--dry-run"))
      return emit(io, fail("invalid_input", "pass --apply or --dry-run, not both"));
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
