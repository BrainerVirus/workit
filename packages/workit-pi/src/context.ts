import {
  invariantBootstrap,
  TaskStore,
  type Capability,
  type OperationContext,
} from "@brainervirus/workit-core/src/core";
import {
  capabilitiesFor,
  PI_DESCRIPTOR,
  sessionCompactContext,
  standingDelta,
  unfinishedTaskOffer as historyOffer,
  type HookInput,
} from "@brainervirus/workit-core/hooks";
import { modelKey } from "@brainervirus/workit-core/src/hooks/model-switch";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { budgetLine, tickBudget } from "@brainervirus/workit-core/src/hooks/budget-signal";

export const piCapabilities = (ctx?: Pick<ExtensionContext, "hasUI">): Capability[] =>
  capabilitiesFor(PI_DESCRIPTOR, { ui: ctx?.hasUI === true });

export const piContext = (ctx: ExtensionContext): OperationContext => ({
  root: ctx.cwd,
  caller: {
    host: "pi",
    actor: process.env.WORKIT_PI_WORKER_SESSION || ctx.sessionManager.getSessionId(),
  },
  workerId:
    process.env.WORKIT_PI_WORKER_ID && process.env.WORKIT_PI_WORKER_SESSION
      ? process.env.WORKIT_PI_WORKER_ID
      : null,
  callerAttested: true,
  provenanceKind: "host_observed",
  capabilities: piCapabilities(ctx),
  constraints: [],
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
});

const taskTurnContext = (ctx: ExtensionContext): string | null => {
  if (!ctx.isProjectTrusted()) return null;
  try {
    const text = sessionCompactContext(
      new TaskStore(ctx.cwd),
      { host: "pi", handle: ctx.sessionManager.getSessionId() },
      piContext(ctx),
    );
    return text ? `Current task context: ${text}` : null;
  } catch {
    // Static contract guidance remains useful when state is unavailable.
    return null;
  }
};

const switchedSessions = new Set<string>();

/** `model_select`: a change from a known previous model owes the session one contract re-send. */
export const noteModelSelect = (
  event: { model: unknown; previousModel?: unknown },
  ctx: Pick<ExtensionContext, "sessionManager">,
): void => {
  const next = modelKey(event.model);
  const previous = modelKey(event.previousModel);
  if (next && previous && next !== previous)
    switchedSessions.add(ctx.sessionManager.getSessionId());
};

/**
 * The compact contract once after a model switch, else null: the new model
 * does not rely on the copy far up its inherited context.
 */
export const modelSwitchContract = (ctx: ExtensionContext): string | null =>
  switchedSessions.delete(ctx.sessionManager.getSessionId()) && ctx.isProjectTrusted()
    ? invariantBootstrap()
    : null;

/** The session's current task context as the per-turn message carries it, or null. */
export const turnContext = (ctx: ExtensionContext): string | null => taskTurnContext(ctx);

/** The session in the shape the core's per-turn resend keys its digest by. */
export const turnInput = (ctx: ExtensionContext): HookInput => ({
  host: "pi",
  cwd: ctx.cwd,
  session: {
    id: ctx.sessionManager.getSessionId(),
    agentId: null,
    agentType: null,
    parentId: null,
  },
  permissionMode: null,
  transcriptPath: null,
  event: { kind: "context.turn" },
});

/**
 * A standing-order change from the lead, once per revision. Pi's tool_call
 * cannot add context, so the change rides the tool result. A supervised
 * worker acts as `<lead>:<worker session>`, which names its lead.
 */
export const standingNotice = (ctx: ExtensionContext): string | null => {
  if (!ctx.isProjectTrusted()) return null;
  const worker = process.env.WORKIT_PI_WORKER_SESSION && process.env.WORKIT_SESSION_ID?.trim();
  const input = turnInput(ctx);
  return standingDelta(worker ? { ...input, session: { ...input.session, id: worker } } : input);
};

/**
 * Count this tool call against the worker's tool-call budget; at N (and 2N…)
 * the one budget line, which rides the tool result like a standing change.
 */
export const budgetNotice = (ctx: ExtensionContext): string | null => {
  if (!ctx.isProjectTrusted()) return null;
  const session =
    (process.env.WORKIT_PI_WORKER_SESSION && process.env.WORKIT_SESSION_ID?.trim()) ||
    ctx.sessionManager.getSessionId();
  return tickBudget(ctx.cwd, session, null) ? budgetLine(ctx.cwd, session, null) : null;
};

/** The session contract: bootstrap plus `taskContext` (see turnContext). */
export const workitContext = (
  ctx: ExtensionContext,
  taskContext: string | null = taskTurnContext(ctx),
): string => {
  const session = ctx.sessionManager.getSessionId();
  if (!ctx.isProjectTrusted())
    return `${invariantBootstrap()}\n\nNative Pi session: ${session}. Project-local Workit state is unavailable until Pi trusts this project.`;
  return `${invariantBootstrap()}\n\nNative Pi session: ${session}.${taskContext ? `\n${taskContext}` : ""}`;
};

export const unfinishedTaskOffer = (ctx: ExtensionContext): string | null => {
  if (!ctx.isProjectTrusted() || process.env.WORKIT_PI_WORKER_ID) return null;
  try {
    const session = piContext(ctx).caller.actor;
    const listed = new TaskStore(ctx.cwd).listTaskIndex();
    return listed.ok ? historyOffer(listed.data, { host: "pi", handle: session }) : null;
  } catch {
    return null;
  }
};
