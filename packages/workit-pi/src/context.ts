import {
  compactTaskContext,
  invariantBootstrap,
  selectMethods,
  TaskStore,
  type Capability,
  type OperationContext,
  type SelectedMethod,
  type TaskView,
  WorkitCore,
} from "@brainervirus/workit-core/src/core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const hostRef = (handle: string) => ({ kind: "host" as const, host: "pi" as const, handle });

export const piCapabilities = (ctx?: Pick<ExtensionContext, "hasUI">): Capability[] => [
  {
    name: "product_write_interception",
    surface: "write/edit tool_call",
    assurance: "enforced",
    reason:
      "Pi exposes a before-tool boundary for known built-in write tools; it enforces project trust while file targets stay host-policy.",
    refs: [hostRef("tool_call")],
  },
  {
    name: "interactive_decision",
    surface: "ui.confirm",
    assurance: ctx?.hasUI ? "enforced" : "unavailable",
    reason: ctx?.hasUI
      ? "Pi supplies a native confirmation receipt when dialog UI is available."
      : "Pi is running without dialog UI, so required decisions need user input.",
    refs: [hostRef("ui.confirm")],
  },
  {
    name: "arbitrary_shell_write",
    surface: "bash",
    assurance: "agent_guided",
    reason: "Pi extensions do not sandbox arbitrary shell commands.",
    refs: [hostRef("tool_call")],
  },
];

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
  let methods: SelectedMethod[] = [];
  try {
    const store = new TaskStore(ctx.cwd);
    const tasks = store.listTasks();
    if (tasks.ok) {
      const task = tasks.data
        .filter(
          (entry) =>
            entry.status !== "closed" &&
            ((entry.intent.provenance.session?.kind === "host" &&
              entry.intent.provenance.session.host === "pi" &&
              entry.intent.provenance.session.handle === session) ||
              entry.workers.some(
                (worker) =>
                  worker.data.session?.kind === "host" &&
                  worker.data.session.host === "pi" &&
                  worker.data.session.handle === session,
              )),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (task) {
        methods = task.policy ? selectMethods(task.policy, piCapabilities(ctx)) : [];
        const core = new WorkitCore(store, piContext(ctx));
        const view = core.task({
          schemaVersion: 1,
          action: "inspect",
          taskId: task.id,
          view: "full",
        });
        if (view.ok) taskContext = compactTaskContext(view.data as TaskView);
      }
    }
  } catch {
    // Static contract guidance remains useful when state is unavailable.
  }
  const methodText = methods.length
    ? `\nSelected methods: ${methods.map((method) => `${method.id} (${method.assurance})`).join(", ")}.`
    : "";
  const taskText = taskContext ? `\nCurrent task context: ${taskContext}` : "";
  return `${invariantBootstrap()}\n\nNative Pi session: ${session}.${methodText}${taskText}`;
};
