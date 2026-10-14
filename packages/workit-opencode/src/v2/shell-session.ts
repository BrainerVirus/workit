// The Workit session of an OpenCode V2 shell. OpenCode's shell tool exports
// OPENCODE_SESSION_ID=<the calling session> into every command it runs (the
// tool's create callback, opencode v2.0.28), which host-session.ts reads. The
// plugin's `shell.hook("create.before")` runs just before that callback and
// carries no session id, so the session is correlated from the shell tool's
// `execute.before` (which does carry it) by command text. With it the hook:
//   - pins WORKIT_HOST=opencode and drops an inherited WORKIT_SESSION_ID, so
//     an outer host's pair or a profile export never stands in for the session;
//   - gives a child session its host-derived identity, WORKIT_SESSION_ID =
//     <lead>:<child> (the shape Claude Code's SubagentStart gives a subagent),
//     which the ledger accepts because it ends in the child's own
//     OPENCODE_SESSION_ID.
import { childSessionId } from "@brainervirus/workit-core/src/host-session";

/**
 * Shell tool calls seen in `execute.before` and not yet created, by command
 * text. `mixed` marks a queue that has held two different sessions at once:
 * which create belongs to which call is then unknown, so every shell of that
 * command gets no derived id until the queue drains.
 */
type PendingQueue = { sessions: string[]; mixed: boolean };
export type PendingShells = Map<string, PendingQueue>;

const PENDING_LIMIT = 256;

const commandText = (input: unknown): string | null => {
  if (input === null || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command : null;
};

/** The shell tool is about to create a shell for `sessionID`. */
export const noteShellCall = (
  pending: PendingShells,
  event: { sessionID: string; input: unknown },
): void => {
  const command = commandText(event.input);
  if (!command) return;
  const sessionID = String(event.sessionID);
  const queue = pending.get(command) ?? { sessions: [], mixed: false };
  if (queue.sessions.some((other) => other !== sessionID)) queue.mixed = true;
  queue.sessions.push(sessionID);
  pending.set(command, queue);
  if (pending.size > PENDING_LIMIT) pending.delete(pending.keys().next().value!);
};

/** The shell tool call ended: forget it if its shell was never created (a denied call). */
export const settleShellCall = (
  pending: PendingShells,
  event: { sessionID: string; input: unknown },
): void => {
  const command = commandText(event.input);
  const queue = command ? pending.get(command) : undefined;
  if (!command || !queue) return;
  const index = queue.sessions.indexOf(String(event.sessionID));
  if (index >= 0) queue.sessions.splice(index, 1);
  if (queue.sessions.length === 0) pending.delete(command);
};

export type ShellCreate = { command: string; env: Record<string, string | undefined> };

/**
 * `shell.create.before`: set the Workit session variables for the shell about
 * to run. `parentOf` resolves a session's parent (undefined for a lead).
 * Once the same command has been in flight from two different sessions at
 * once, its shells get no derived id until its queue drains, never a wrong
 * one (they fall back to their own OPENCODE_SESSION_ID).
 */
export const applyShellSession = async (
  pending: PendingShells,
  event: ShellCreate,
  parentOf: (sessionID: string) => Promise<string | undefined>,
): Promise<void> => {
  event.env.WORKIT_HOST = "opencode";
  delete event.env.WORKIT_SESSION_ID;
  const queue = pending.get(event.command);
  if (!queue || queue.sessions.length === 0) return;
  const sessionID = queue.sessions.shift()!;
  if (queue.sessions.length === 0) pending.delete(event.command);
  if (queue.mixed) return;
  const parent = await parentOf(sessionID);
  if (parent) event.env.WORKIT_SESSION_ID = childSessionId(parent, sessionID);
};
