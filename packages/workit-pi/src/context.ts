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

export const workitContext = (ctx: ExtensionContext): string => {
  const session = ctx.sessionManager.getSessionId();
  if (!ctx.isProjectTrusted())
    return `${invariantBootstrap()}\n\nNative Pi session: ${session}. Project-local Workit state is unavailable until Pi trusts this project.`;
  let taskContext: string | null = null;
  try {
    taskContext = sessionCompactContext(
      new TaskStore(ctx.cwd),
      { host: "pi", handle: session },
      piContext(ctx),
    );
  } catch {
    // Static contract guidance remains useful when state is unavailable.
  }
  const taskText = taskContext ? `\nCurrent task context: ${taskContext}` : "";
  return `${invariantBootstrap()}\n\nNative Pi session: ${session}.${taskText}`;
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
