// `workit gc`: bounded task state. Compacts long task event logs into a
// checkpoint plus their recent events (never losing the latest state),
// removes unreferenced candidate blobs and crashed writers' temp files, and
// prunes `workit check` log blobs (LOG_RETENTION). A 2.x `.workit/recovery`
// directory left by migration is only reported unless `--prune-recovery --yes`.
// `--dry-run` is read-only.
import { LOG_RETENTION, pruneCheckLogs } from "@brainervirus/workit-core/src/checks";
import { TaskStore } from "@brainervirus/workit-core/src/core/task-store";
import { emit, fail, ok, type Io } from "../output";
import { workspaceRootFor } from "../task";

const megabytes = (bytes: number): string => (bytes / 1_048_576).toFixed(1);

export async function run(argv: string[], io: Io): Promise<number> {
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
  const result = store.collectGarbage({ dryRun, pruneRecovery });
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
      `task logs: ${verb} compact ${compacted.tasks.length} (${compacted.eventsFolded} events folded${data.dryRun ? "" : `, ${megabytes(compacted.bytesBefore)} → ${megabytes(compacted.bytesAfter)} MB`})${data.failed.length ? `; failed ${data.failed.join(", ")}` : ""}`,
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
