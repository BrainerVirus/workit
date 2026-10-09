// Stop control on OpenCode V2: when a main session goes idle with a provable
// unmet obligation (core stopDecision), one synthetic message names it and
// resumes the session (`ctx.session.synthetic` with `resume: true`,
// @opencode/client 2.0.18). OpenCode has no stop hook and no loop guard: the
// run that continuation starts always ends freely. Child sessions, other
// checkouts, a run that did not succeed (interrupted, failed) and every
// failure leave the session idle.
import { OPENCODE_DESCRIPTOR, stopDecision } from "@brainervirus/workit-core/hooks";
import { sameWorkspace } from "../shared/session";

type IdleSession = {
  id: string;
  parentID?: string;
  directory: string;
  outcome?: "succeeded" | "failed" | "interrupted";
};

export type StopPort = {
  getSession: (sessionID: string) => Promise<IdleSession | null>;
  /** The session's messages, oldest first (`ctx.session.context`). */
  messages: (sessionID: string) => Promise<readonly unknown[]>;
  /** Queue a synthetic message that resumes the session. */
  resume: (sessionID: string, text: string) => Promise<unknown>;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The text of the last assistant message, or null. */
export const lastAssistantText = (messages: readonly unknown[]): string | null => {
  for (const message of messages.toReversed()) {
    if (record(message).type !== "assistant") continue;
    const content = record(message).content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((part) => record(part).type === "text" && typeof record(part).text === "string")
      .map((part) => record(part).text as string)
      .join("\n");
    return text || null;
  }
  return null;
};

/** One stop controller per plugin: `onIdle` handles a `session.idle` event. */
export const createStopControl = (root: string, port: StopPort) => {
  const continued = new Set<string>();
  return {
    onIdle: async (sessionID: string): Promise<boolean> => {
      try {
        if (continued.delete(sessionID)) return false;
        const session = await port.getSession(sessionID);
        if (!session || session.parentID !== undefined) return false;
        // Only a run that finished on its own: an interrupted (Esc) or failed
        // one is never resumed.
        if (session.outcome !== "succeeded") return false;
        if (!sameWorkspace(root, session.directory)) return false;
        const lastMessage = lastAssistantText(await port.messages(sessionID));
        const decision = stopDecision(
          {
            host: "opencode",
            cwd: root,
            session: { id: sessionID, agentId: null, agentType: null, parentId: null },
            permissionMode: null,
            transcriptPath: null,
            event: { kind: "stop", lastMessage, stopHookActive: false },
          },
          OPENCODE_DESCRIPTOR,
        );
        if (decision.kind !== "continue") return false;
        continued.add(sessionID);
        await port.resume(sessionID, decision.reason);
        return true;
      } catch {
        // Fail open: the session stays idle.
        return false;
      }
    },
  };
};
