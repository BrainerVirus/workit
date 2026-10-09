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
  unfinishedTaskOffer as historyOffer,
  type HookInput,
} from "@brainervirus/workit-core/hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/**
 * The session's current task context as the per-turn message carries it, or
 * null when the project is untrusted or no task applies.
 */
export const turnContext = (ctx: ExtensionContext): string | null => {
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

/** The session contract: bootstrap plus `taskContext` (see turnContext). */
export const workitContext = (
  ctx: ExtensionContext,
  taskContext: string | null = turnContext(ctx),
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
