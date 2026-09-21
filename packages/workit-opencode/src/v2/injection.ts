import { getWorkitBootstrap } from "../bootstrap";
import { compactContextFor, workerContextFor } from "../runtime";
import { sameWorkspace } from "../shared/session";

export type SystemPart = { type?: unknown; text?: unknown };

export type InjectionSession = {
  id: string;
  parentID?: string;
  directory?: string;
};

const textPart = (text: string) => ({ type: "text" as const, text });

const hasMarker = (system: SystemPart[], marker: string): boolean =>
  system.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.includes(marker),
  );

/**
 * Model-visible Workit context for one agent-loop call: the contract
 * bootstrap for leads, the compact task context whenever one applies, and the
 * worker context for validated direct children. Markers dedupe within this
 * event only, never across later policy changes.
 */
export const injectAgentContext = (
  root: string,
  session: InjectionSession | null,
  directChildren: Map<string, string>,
  system: SystemPart[],
): void => {
  if (!session || !sameWorkspace(root, session.directory)) return;
  const bootstrap = session.parentID === undefined ? getWorkitBootstrap() : null;
  const taskContext = compactContextFor(root, session.id);
  const workerContext = session.parentID
    ? workerContextFor(root, session.id, session.parentID, directChildren)
    : null;
  if (bootstrap && !hasMarker(system, "<workit-contract>")) system.unshift(textPart(bootstrap));
  if (taskContext && !hasMarker(system, "<workit-task-context>"))
    system.unshift(textPart(`<workit-task-context>${taskContext}</workit-task-context>`));
  if (workerContext && !hasMarker(system, "<workit-worker-context>"))
    system.unshift(textPart(`<workit-worker-context>${workerContext}</workit-worker-context>`));
};

/** Compaction keeps its normal model call: task context is appended as a text
 * system part when absent and `result` is never set. */
export const injectCompactionContext = (
  root: string,
  sessionID: string,
  system: SystemPart[],
): void => {
  const context = compactContextFor(root, sessionID);
  if (!context || hasMarker(system, "<workit-task-context>")) return;
  system.push(textPart(`<workit-task-context>${context}</workit-task-context>`));
};
