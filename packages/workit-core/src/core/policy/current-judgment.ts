import type { Judgment } from "../task-contract";
import { TaskStore } from "../task-store";
import { latestJudgment } from "./derive";

/** The open task's latest judgment (the one policy/derive.ts reads), or null when none is recorded. Never throws. */
export function currentJudgment(cwd: string): Judgment | null {
  try {
    const store = new TaskStore(cwd);
    const listed = store.listTaskIndex();
    const key = store.currentKey();
    if (!listed.ok || !key.ok) return null;
    const entry = listed.data
      .filter((item) => item.key === key.data.key && item.status !== "closed")
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const task = entry ? store.readTask(entry.id) : null;
    return task?.ok === true ? latestJudgment(task.data) : null;
  } catch {
    return null;
  }
}
