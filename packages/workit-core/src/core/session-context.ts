import path from "node:path";
import { canonicalJson } from "./task-contract";
import { WorkitCore, type OperationContext } from "./task-engine";
import { fileSignature, type TaskIndexEntry, type TaskStore } from "./task-store";

/** A native host session, e.g. `{ host: "opencode", handle: sessionID }`. */
export type SessionHandle = { host: string; handle: string };

const boundTo = (entry: TaskIndexEntry, session: SessionHandle): boolean =>
  entry.sessions.some((item) => item.host === session.host && item.handle === session.handle);
const newestFirst = (left: TaskIndexEntry, right: TaskIndexEntry): number =>
  right.updatedAt.localeCompare(left.updatedAt);

/** The most recently updated open task bound to `session` (as lead or worker). */
export const sessionTaskEntry = (
  entries: TaskIndexEntry[],
  session: SessionHandle,
): TaskIndexEntry | null =>
  entries
    .filter((entry) => entry.status !== "closed" && boundTo(entry, session))
    .sort(newestFirst)[0] ?? null;

/** Up to `limit` open tasks not bound to `session`, newest first. */
export const unboundOpenTaskEntries = (
  entries: TaskIndexEntry[],
  session: SessionHandle,
  limit = 3,
): TaskIndexEntry[] =>
  entries
    .filter((entry) => entry.status !== "closed" && !boundTo(entry, session))
    .sort(newestFirst)
    .slice(0, limit);

const filesKey = (files: string[]): string =>
  files.map((file) => fileSignature(file) ?? "-").join("\0");

type CachedContext = { key: string; files: string[]; filesKey: string; value: string };
const CACHE_LIMIT = 64;
const cache = new Map<string, CachedContext>();

/**
 * Compact context for `session`'s current task, for per-turn host injection.
 *
 * Reads the task index (no full-record parse for unrelated tasks), never
 * captures a candidate, and reuses the previous result while the task file,
 * the workspace record, and the decision documents it cites are unchanged.
 */
export function sessionCompactContext(
  store: TaskStore,
  session: SessionHandle,
  context: OperationContext,
): string | null {
  const listed = store.listTaskIndex();
  if (!listed.ok) return null;
  const entry = sessionTaskEntry(listed.data, session);
  if (!entry) return null;
  const slot = `${store.root}\0${session.host}\0${session.handle}`;
  const key = canonicalJson({
    task: entry.id,
    file: entry.file,
    workspace: store.workspaceSignature() ?? "-",
    caller: context.caller,
    workerId: context.workerId ?? null,
    capabilities: context.capabilities,
  });
  const hit = cache.get(slot);
  if (hit && hit.key === key && hit.filesKey === filesKey(hit.files)) return hit.value;
  const task = store.readTask(entry.id);
  if (!task.ok) return null;
  const files = task.data.decisions.flatMap((decision) =>
    decision.data.binding.contentRefs.flatMap((ref) =>
      ref.kind === "file" ? [path.resolve(store.root, ref.path)] : [],
    ),
  );
  const observed = filesKey(files);
  const compact = new WorkitCore(store, context).compactContext(entry.id);
  if (!compact.ok) return null;
  cache.delete(slot);
  cache.set(slot, { key, files, filesKey: observed, value: compact.data });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compact.data;
}
