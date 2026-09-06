import { readFileSync } from "node:fs";

import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import type { Logger } from "@brainervirus/workit-core/src/core/logger";
import {
  compactTaskContext,
  TaskStore,
  WorkitCore,
  type TaskView,
} from "@brainervirus/workit-core/src/core";

export const compactContextFor = (root: string, sessionID: string): string | null => {
  try {
    const store = new TaskStore(root);
    const listed = store.listTasks();
    if (!listed.ok) return null;
    const task = listed.data
      .filter(
        (entry) =>
          entry.status !== "closed" &&
          ((entry.intent.provenance.session?.kind === "host" &&
            entry.intent.provenance.session.host === "opencode" &&
            entry.intent.provenance.session.handle === sessionID) ||
            entry.workers.some(
              (worker) =>
                worker.data.session?.kind === "host" &&
                worker.data.session.host === "opencode" &&
                worker.data.session.handle === sessionID,
            )),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!task) return null;
    const core = new WorkitCore(store, {
      root,
      caller: { host: "opencode", actor: sessionID },
      capabilities: [],
      constraints: [],
      now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const view = core.task({ schemaVersion: 1, action: "inspect", taskId: task.id, view: "full" });
    return view.ok ? compactTaskContext(view.data as TaskView) : null;
  } catch {
    return null;
  }
};

export const workerContextFor = (
  root: string,
  sessionID: string,
  parentID: string,
  directChildren?: Map<string, string>,
): string | null => {
  try {
    const store = new TaskStore(root);
    const listed = store.listTasks();
    if (!listed.ok) return null;
    for (const task of listed.data) {
      const worker = task.workers.find(
        (entry) =>
          entry.data.session?.kind === "host" &&
          entry.data.session.handle === sessionID &&
          directChildren?.get(sessionID) === parentID,
      );
      if (!worker) continue;
      return JSON.stringify({
        taskId: task.id,
        role: worker.data.assignment.role,
        scope: worker.data.assignment.scope,
        readOnly: worker.data.assignment.role !== "implementer",
        stoppingCondition: worker.data.assignment.stoppingCondition,
      });
    }
  } catch {
    return null;
  }
  return null;
};

export const loadProvenance = (logger: Logger, pkgUrl: string | URL): Record<string, string> => {
  try {
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { name?: string; version?: string };
    return {
      name: String(pkg.name ?? "workit-opencode"),
      version: String(pkg.version ?? "unknown"),
    };
  } catch (err) {
    logger.warn(EVENT.provenance, errorDetail(err));
    return { name: "workit-opencode", version: "unknown" };
  }
};
