import {
  childSessionId,
  judgeBranch,
  verdictCommand,
} from "@brainervirus/workit-core/src/host-session";
import { standingSinceStart } from "@brainervirus/workit-core/src/hooks/standing";
import { getWorkitBootstrap } from "../bootstrap";
import { compactContextFor, unfinishedTaskOfferFor, workerContextFor } from "../runtime";
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
  const verdict = session.parentID ? judgeVerdictText(root, session, workerContext) : null;
  if (verdict && !hasMarker(system, "<workit-verdict-line>"))
    system.push(textPart(`<workit-verdict-line>${verdict}</workit-verdict-line>`));
  const standing = session.parentID ? standingFor(root, session) : null;
  if (standing && !hasMarker(system, "<workit-standing>"))
    system.push(textPart(`<workit-standing>${standing}</workit-standing>`));
};

/**
 * Standing orders the lead changed since this child started: the system
 * context is rebuilt every model call, so the change stands on each call
 * until the lead changes it again.
 */
const standingFor = (root: string, session: InjectionSession): string | null =>
  standingSinceStart({
    host: "opencode",
    cwd: session.directory ?? root,
    session: { id: session.id, agentId: null, agentType: null, parentId: session.parentID ?? null },
    permissionMode: null,
    transcriptPath: null,
    event: { kind: "context.turn" },
  });

const workerRole = (workerContext: string | null): unknown => {
  if (!workerContext) return null;
  try {
    return (JSON.parse(workerContext) as { role?: unknown }).role;
  } catch {
    return null;
  }
};

/**
 * A child that may judge (no Workit worker, or a read-only one) is told its
 * exact verdict command. Its shell already acts as `<lead>:<child>`
 * (shell-session.ts), so the command names no session or token; an
 * implementer worker gets none.
 */
const judgeVerdictText = (
  root: string,
  session: InjectionSession,
  workerContext: string | null,
): string | null => {
  const role = workerRole(workerContext);
  if (role === "implementer") return null;
  const line = verdictCommand({
    branch: judgeBranch(session.directory ?? root),
    judge: role === "reviewer" ? "reviewer" : null,
  });
  return `If this session verifies or reviews a candidate, record its verdict with exactly this command (pick the result and kind, live when you drove the real surface, name the candidate branch if it differs, say what you ran): \`${line}\`. Your shell already acts as your own Workit session ${childSessionId(session.parentID ?? "", session.id)}: pass no --session or --token, and never set WORKIT_SESSION_ID by hand.`;
};

export const injectHistoryOffer = (
  root: string,
  session: InjectionSession | null,
  offeredSessions: Set<string>,
  system: SystemPart[],
): void => {
  if (
    !session ||
    session.parentID !== undefined ||
    !sameWorkspace(root, session.directory) ||
    offeredSessions.has(session.id)
  )
    return;
  offeredSessions.add(session.id);
  const offer = unfinishedTaskOfferFor(root, "opencode", session.id);
  if (offer && !hasMarker(system, "<workit-history-offer>")) system.push(textPart(offer));
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
