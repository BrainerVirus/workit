import { CURSOR_DESCRIPTOR, capabilitiesFor } from "@brainervirus/workit-core/hooks";

export type HookAvailability = Partial<
  Record<
    "sessionStart" | "preToolUse" | "beforeShellExecution" | "subagentStart" | "subagentStop",
    boolean
  >
>;

/** Capability mapping is deliberately conservative: AskQuestion answers are not
 * observable by this command hook, and arbitrary shell writes are not parseable.
 * The MCP/session process cannot attest that Cursor loaded its hook manifest;
 * only the dispatcher handling the corresponding event may claim enforcement. */
export const cursorCapabilities = (availability: HookAvailability = {}) =>
  capabilitiesFor(CURSOR_DESCRIPTOR, {
    "session.start": availability.sessionStart,
    "tool.pre": availability.preToolUse,
    "shell.pre": availability.beforeShellExecution,
    "subagent.start": availability.subagentStart,
    "subagent.stop": availability.subagentStop,
  });
