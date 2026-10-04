// `workit gc`: bounded recovery state for the workspace root's .workit
// (WORKFLOW_WORKSPACE_ROOT, then --cwd/cwd), plus `workit check` log blobs in
// the repo store (LOG_RETENTION). `--dry-run` is read-only.
import { LOG_RETENTION, pruneCheckLogs } from "@brainervirus/workit-core/src/checks";
import { storeRoot } from "@brainervirus/workit-core/src/ledger";
import { TaskStore } from "@brainervirus/workit-core/src/core/task-store";
import { emit, fail, ok, type Io } from "../output";
import { workspaceRootFor } from "../task";

export async function run(argv: string[], io: Io): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const store = storeRoot(io.cwd);
  const logs = store.ok ? pruneCheckLogs(store.value.root, { dryRun }) : null;
  const result = new TaskStore(workspaceRootFor({ cwd: io.cwd })).collectGarbage({ dryRun });
  if (!result.ok)
    return emit(
      io,
      fail(result.code === "busy" ? "busy" : "failed", `${result.code}: ${result.error}`, {
        data: { code: result.code, details: result.details },
        ...(result.code === "busy" ? { unblock: "retry `workit gc`" } : {}),
      }),
    );
  return emit(io, ok({ ...result.data, logs }), (data) => {
    const verb = data.dryRun ? "would remove" : "removed";
    const megabytes = (data.recovery.removedBytes / 1_048_576).toFixed(1);
    const { candidates } = data;
    return [
      `workit gc${data.dryRun ? " (dry run)" : ""}`,
      `recovery: ${verb} ${data.recovery.removed} copies (${megabytes} MB), kept ${data.recovery.kept}`,
      `temporary files: ${verb} ${data.temporary.removed}`,
      `candidates: ${verb} ${candidates.removed} duplicates in ${candidates.tasks.length} tasks` +
        (candidates.skippedActive.length
          ? `; skipped active ${candidates.skippedActive.join(", ")}`
          : "") +
        (candidates.skippedClosed.length
          ? `; skipped closed ${candidates.skippedClosed.join(", ")}`
          : "") +
        (candidates.failed.length ? `; failed ${candidates.failed.join(", ")}` : ""),
      ...(data.logs
        ? [
            `check logs: ${verb} ${data.logs.removed} (${(data.logs.removedBytes / 1_048_576).toFixed(1)} MB), kept ${data.logs.kept} (newest ${LOG_RETENTION.maxCount}, ≤${LOG_RETENTION.maxAgeMs / 86_400_000} days)`,
          ]
        : []),
    ];
  });
}
