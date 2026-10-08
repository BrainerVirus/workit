// Pi: an in-process extension; its events call core/hooks functions directly.
import type { HostDescriptor } from "../descriptor";

export const PI_DESCRIPTOR: HostDescriptor = {
  host: "pi",
  label: "Pi",
  verifiedAgainst: "@earendil-works/pi-coding-agent 0.85.1",
  docs: ["https://github.com/earendil-works/pi-coding-agent"],
  transport: "in-process-plugin",
  events: {
    "session.start": { support: "native", native: "session_start" },
    "context.turn": { support: "native", native: "before_agent_start" },
    "shell.pre": { support: "native", native: "tool_call" },
    "tool.pre": { support: "native", native: "tool_call" },
    "write.pre": { support: "native", native: "tool_call" },
    "shell.post": { support: "native", native: "tool_result" },
    // Workers are supervised stock-Pi processes, not host subagents.
    "subagent.start": { support: "none", native: null },
    "subagent.stop": { support: "none", native: null },
    "prompt.submit": { support: "undocumented", native: null },
    "compact.pre": { support: "native", native: "session_before_compact" },
    stop: { support: "none", native: null },
  },
  shellPolicy: { deny: "native", channel: "block", failClosed: false },
  context: {
    sessionStart: "native",
    perTurn: "native",
    afterCompact: "native",
    task: "session-bound",
    turnResend: "every-turn",
  },
  subagents: {
    identity: "none",
    parentBinding: "none",
    blockStart: "none",
    worktreeIsolation: "none",
    maxConcurrency: "undocumented",
  },
  provenance: { sessionId: "native", agentIdOnTool: "none", postToolObserve: "native" },
  interaction: { questions: "native", writeBoundary: "native" },
  stopControl: "none",
  shellAvailable: "native",
  perEventCost: "low",
  capabilities: [
    {
      name: "product_write_interception",
      surface: "write/edit tool_call",
      refs: ["tool_call"],
      requires: ["interaction.writeBoundary"],
      assurance: "enforced",
      reason:
        "Pi exposes a before-tool boundary for known built-in write tools; it enforces project trust while file targets stay host-policy.",
    },
    {
      name: "arbitrary_shell_write",
      surface: "bash",
      refs: ["tool_call"],
      requires: ["shellAvailable"],
      assurance: "agent_guided",
      reason: "Pi extensions do not sandbox arbitrary shell commands.",
    },
    {
      name: "fresh-context-review",
      surface: "supervised_worker",
      refs: ["worker"],
      requires: [],
      assurance: "agent_guided",
      reason:
        "independent review runs as a supervised stock-Pi process; evidence evaluation enforces reviewer exclusivity",
    },
  ],
};
