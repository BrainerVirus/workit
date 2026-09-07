import {
  invariantBootstrap,
  selectMethods,
  TaskStore,
  type Capability,
  type OperationContext,
} from "@brainervirus/workit-core/src/core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const hostRef = (handle: string) => ({ kind: "host" as const, host: "pi" as const, handle });

export const piCapabilities = (): Capability[] => [
  {
    name: "product_write_interception",
    surface: "write/edit tool_call",
    assurance: "enforced",
    reason: "Pi exposes a before-tool boundary for known built-in write tools.",
    refs: [hostRef("tool_call")],
  },
  {
    name: "interactive_decision",
    surface: "ui.confirm",
    assurance: "enforced",
    reason: "Pi supplies a native confirmation receipt when dialog UI is available.",
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
  caller: { host: "pi", actor: ctx.sessionManager.getSessionId() },
  callerAttested: true,
  provenanceKind: "host_observed",
  capabilities: piCapabilities(),
  constraints: [],
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
});

export const workitContext = (ctx: ExtensionContext): string => {
  const store = new TaskStore(ctx.cwd);
  const tasks = store.listTasks();
  const methods =
    tasks.ok && tasks.data.length === 1 && tasks.data[0].policy
      ? selectMethods(tasks.data[0].policy, piCapabilities())
      : [];
  const methodText = methods.length
    ? `\nSelected methods: ${methods.map((method) => `${method.id} (${method.assurance})`).join(", ")}.`
    : "";
  return `${invariantBootstrap()}\n\nNative Pi session: ${ctx.sessionManager.getSessionId()}.${methodText}`;
};
