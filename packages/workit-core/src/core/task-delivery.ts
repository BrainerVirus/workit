import { readFileSync, writeFileSync } from "node:fs";
import { ledgerPath, readLedger } from "../ledger";
import { fileSignature, racySignature, type TaskStore } from "./task-store";
import { success, type Utc } from "./task-contract";
import { workerBlocksTransition } from "./workers";

/**
 * Close every open task whose branch the ledger shows merged (`pr.merged`) and
 * delivered (`delivery.verified`, expect merged) after the task began, so a
 * delivered task stops showing as active (#322). A merge without a verified
 * delivery leaves the task open and names `workit verify-delivery merged` as its
 * next action. Tasks without a PR, or with a worker that blocks closing, are
 * left alone. Best effort: a failed read or write skips the task.
 */
export function closeDeliveredTasks(
  store: TaskStore,
  now: Utc,
  options: { cached?: boolean } = {},
): number {
  let closedCount = 0;
  const index = store.listStoreIndex();
  if (!index.ok) return 0;
  const open = index.data.filter((entry) => entry.status !== "closed" && entry.branch !== null);
  if (open.length === 0) return 0;
  // Hot paths sweep only when the ledger or the open-task set changed.
  const file = options.cached ? ledgerPath(store.root) : null;
  const signature = file?.ok
    ? `${fileSignature(file.value) ?? "-"}|${open.map((entry) => entry.id).join(",")}`
    : null;
  const marker = file?.ok ? `${file.value}.delivery-sweep` : null;
  if (signature && marker) {
    try {
      if (readFileSync(marker, "utf8") === signature) return 0;
    } catch {
      // no marker yet
    }
  }
  const ledger = readLedger(store.root);
  if (!ledger.ok) return 0;
  const rows = ledger.value.rows as {
    type: string;
    branch?: unknown;
    pr?: unknown;
    id: string;
    at: string;
    expect?: unknown;
  }[];
  const after = (row: { at: string }, since: string) => Date.parse(row.at) >= Date.parse(since);
  for (const entry of open) {
    const merged = rows.findLast(
      (row) =>
        row.type === "pr.merged" &&
        row.branch === entry.branch &&
        typeof row.pr === "number" &&
        after(row, entry.createdAt),
    );
    if (!merged) continue;
    const pr = merged.pr as number;
    const verified = rows.findLast(
      (row) =>
        row.type === "delivery.verified" &&
        row.expect === "merged" &&
        row.branch === entry.branch &&
        (row.pr === undefined || row.pr === pr),
    );
    if (!verified) {
      const next = `PR #${pr} is merged but delivery is not verified: run \`workit verify-delivery merged\``;
      if (entry.progress.nextAction !== next) {
        store.mutateTask(entry.id, entry.revision, (task, context) =>
          success(context.revision, null, {
            ...task,
            progress: { ...task.progress, nextAction: next },
          }),
        );
      }
      continue;
    }
    const task = store.readTask(entry.id);
    if (!task.ok || task.data.status === "closed") continue;
    if (task.data.workers.some((worker) => workerBlocksTransition("close", worker.data.state)))
      continue;
    const closed = store.mutateTask(
      entry.id,
      task.data.revision,
      (value, context) =>
        success(context.revision, null, {
          ...value,
          status: "closed",
          closure: {
            outcome: "verified",
            at: context.now,
            summary: `delivered: PR #${pr} merged (pr.merged ${String(merged.id)}) and delivery verified (delivery.verified ${String(verified.id)})`,
            decisionIds: [],
            evidenceIds: [],
          },
        }),
      now,
    );
    if (closed.ok) closedCount++;
  }
  if (signature && marker && closedCount === 0 && !racySignature(signature.split("|")[0] ?? "")) {
    try {
      writeFileSync(marker, signature);
    } catch {
      // the next call sweeps again
    }
  }
  return closedCount;
}
