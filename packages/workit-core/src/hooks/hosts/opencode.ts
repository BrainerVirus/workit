// OpenCode V2: an in-process plugin; hooks call core/hooks functions directly.
import type { HostDescriptor } from "../descriptor";

export const OPENCODE_DESCRIPTOR: HostDescriptor = {
  host: "opencode",
  label: "OpenCode",
  verifiedAgainst: "@opencode-ai/plugin 1.18.30",
  docs: ["https://opencode.ai/docs/plugins/"],
  transport: "in-process-plugin",
  events: {
    // No separate start event: context is injected on every agent-loop call.
    "session.start": { support: "none", native: null },
    "context.turn": { support: "native", native: 'session.hook("context")' },
    "shell.pre": { support: "native", native: 'permission.hook("evaluate")' },
    "tool.pre": { support: "native", native: 'tool.hook("execute.before")' },
    "shell.post": { support: "native", native: 'tool.hook("execute.after")' },
    "subagent.start": { support: "native", native: 'tool.hook("execute.before") subagent' },
    "subagent.stop": { support: "native", native: 'tool.hook("execute.after") subagent' },
    "prompt.submit": { support: "undocumented", native: null },
    "compact.pre": { support: "native", native: 'session.hook("compaction")' },
    stop: { support: "partial", native: "session.idle" },
  },
  shellPolicy: { deny: "native", channel: "effect", failClosed: false },
  context: {
    sessionStart: "none",
    perTurn: "native",
    afterCompact: "native",
    task: "session-bound",
  },
  subagents: {
    identity: "native",
    parentBinding: "native",
    blockStart: "native",
    worktreeIsolation: "undocumented",
    maxConcurrency: "undocumented",
  },
  provenance: { sessionId: "native", agentIdOnTool: "native", postToolObserve: "native" },
  interaction: { questions: "native", writeBoundary: "partial" },
  stopControl: "partial",
  shellAvailable: "native",
  perEventCost: "low",
  capabilities: [
    {
      name: "interactive_decision",
      surface: "question",
      refs: ["question"],
      requires: ["interaction.questions"],
      assurance: "enforced",
      reason: "native question answers are observed by tool.execute.after and consumed once",
    },
    {
      name: "known_product_writes",
      surface: "edit/shell",
      refs: ["permission.evaluate"],
      requires: [],
      assurance: "unavailable",
      reason:
        "file writes are host-policy; OpenCode native permissions govern them, workit no longer gates write tools",
    },
    {
      name: "direct_child_workers",
      surface: "subagent",
      refs: ["subagent"],
      requires: ["subagents.parentBinding", "subagents.blockStart"],
      assurance: "enforced",
      reason:
        "nested subagent launches are denied and observed child sessions are parent-bound before they may own a worker",
    },
    {
      name: "fresh-context-review",
      surface: "subagent",
      refs: ["subagent"],
      requires: ["event:subagent.start"],
      assurance: "agent_guided",
      reason:
        "independent review runs as a native child session; evidence evaluation enforces creator and duplicate-reviewer exclusion",
    },
  ],
};
