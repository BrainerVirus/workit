// Where the event store keeps a checkout's files, for tests that inspect or
// tamper with them (see packages/workit-core/src/core/task-store.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockPathFor } from "@/packages/workit-core/src/core/store-lock";
import { resolveStore } from "@/packages/workit-core/src/store/paths";
import { reduce, type ReducedTask } from "@/packages/workit-core/src/store/reduce";

/** The store directory serving `root`. */
export const storeDirOf = (root: string): string => {
  const location = resolveStore(root);
  if (location instanceof Error) throw location;
  return location.dir;
};

/** The checkout's workspace record. */
export const workspaceFileOf = (root: string): string =>
  join(dirname(lockPathFor(root)), "workspace.json");

export const taskDirOf = (root: string, taskId: string): string =>
  join(storeDirOf(root), "tasks", taskId);

export const eventsFileOf = (root: string, taskId: string): string =>
  join(taskDirOf(root, taskId), "events.jsonl");

/** The parsed events of a task's log (complete lines only). */
export const eventsOf = (root: string, taskId: string): Array<Record<string, any>> =>
  readFileSync(eventsFileOf(root, taskId), "utf8")
    .split("\n")
    .filter((line, index, lines) => line && index < lines.length - 1)
    .map((line) => JSON.parse(line));

/**
 * Replace a task's log with one opening event holding `record` (as an older
 * or newer writer, or an editor, might leave it) and drop its snapshot.
 */
export const rewriteTaskLog = (
  root: string,
  taskId: string,
  record: unknown,
  extra: Record<string, unknown> = {},
): void => {
  mkdirSync(taskDirOf(root, taskId), { recursive: true });
  rmSync(join(taskDirOf(root, taskId), "snapshot.json"), { force: true });
  writeFileSync(
    eventsFileOf(root, taskId),
    `${JSON.stringify({
      v: 1,
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      id: "00000000-0000-4000-8000-0000000000aa",
      task: taskId,
      actor: null,
      type: "task.opened",
      data: { record, key: null },
      ...extra,
    })}\n`,
  );
};

/**
 * The raw record a task's log replays to, including keys this runtime would
 * strip on a validated read (blob references resolved).
 */
export const rawRecordOf = (root: string, taskId: string): Record<string, any> => {
  const blobs = join(storeDirOf(root), "blobs", "candidates");
  const store = {
    read: (digest: string) => JSON.parse(readFileSync(join(blobs, `${digest}.json`), "utf8")),
    write: () => {},
  };
  let state: ReducedTask | null = null;
  for (const event of eventsOf(root, taskId)) state = reduce(state, event as never, store);
  if (!state) throw new Error(`task ${taskId} has no events`);
  return state.record;
};
