import { readFileSync } from "node:fs";

import { EVENT, errorDetail } from "@brainervirus/workit-core/src/core/boundary";
import type { Logger } from "@brainervirus/workit-core/src/core/logger";
import { TaskStore } from "@brainervirus/workit-core/src/core";
import { sessionCompactContext, unfinishedTaskOffer } from "@brainervirus/workit-core/hooks";

export const compactContextFor = (root: string, sessionID: string): string | null => {
  try {
    return sessionCompactContext(
      new TaskStore(root),
      { host: "opencode", handle: sessionID },
      {
        root,
        caller: { host: "opencode", actor: sessionID },
        capabilities: [],
        constraints: [],
        now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    );
  } catch {
    return null;
  }
};

export const unfinishedTaskOfferFor = (
  root: string,
  host: string,
  sessionID: string,
): string | null => {
  try {
    const listed = new TaskStore(root).listTaskIndex();
    return listed.ok ? unfinishedTaskOffer(listed.data, { host, handle: sessionID }) : null;
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
  if (directChildren?.get(sessionID) !== parentID) return null;
  try {
    const store = new TaskStore(root);
    const listed = store.listTaskIndex();
    if (!listed.ok) return null;
    for (const entry of listed.data) {
      const bound = entry.sessions.find(
        (item) => item.workerId !== null && item.host === "opencode" && item.handle === sessionID,
      );
      if (!bound) continue;
      const task = store.readTask(entry.id);
      if (!task.ok) return null;
      const worker = task.data.workers.find((item) => item.id === bound.workerId);
      if (!worker) continue;
      return JSON.stringify({
        taskId: task.data.id,
        workerId: worker.id,
        session: { kind: "host", host: "opencode", handle: sessionID },
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
