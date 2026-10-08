// OpenCode V2 skill routing: a Workit skill load through the skill tool is
// recorded for the session, and a new user prompt naming a skill's trigger
// gets one system line naming the skill (core hooks/skill-nudge.ts).
import { promptNudge, recordSkillLoad, type HookInput } from "@brainervirus/workit-core/hooks";

const hookInput = (root: string, sessionID: string, subagent: boolean): HookInput => ({
  host: "opencode",
  cwd: root,
  session: {
    id: sessionID,
    agentId: subagent ? sessionID : null,
    agentType: null,
    parentId: null,
  },
  permissionMode: null,
  transcriptPath: null,
  event: { kind: "context.turn" },
});

/** Before OpenCode's skill tool runs: record a Workit skill load. Never throws. */
export const observeSkillLoad = (
  root: string,
  event: { sessionID: string; input: unknown },
): void => {
  const input = event.input as { name?: unknown } | null;
  if (typeof input?.name === "string")
    recordSkillLoad(hookInput(root, String(event.sessionID), false), input.name, "tool");
};

type Part = { type?: unknown; text?: unknown };
type ContextMessage = { role?: unknown; content?: unknown };

/** The text of the request's last message when it is the user's: a new turn, not a tool step. */
const newUserPrompt = (messages: readonly unknown[]): string | null => {
  const last = messages.at(-1) as ContextMessage | undefined;
  if (last?.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return null;
  const text = (last.content as Part[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  return text || null;
};

/** The session context hook: the prompt's skill nudge as one system line. Never throws. */
export const injectSkillNudge = (
  root: string,
  session: { id: string; parentID?: string },
  messages: readonly unknown[],
  system: unknown[],
): void => {
  try {
    const nudge = promptNudge(
      hookInput(root, session.id, session.parentID !== undefined),
      newUserPrompt(messages),
    );
    if (nudge) system.push({ type: "text", text: nudge });
  } catch {
    // Fail open.
  }
};
