// Role models on an OpenCode subagent spawn (#654): the `subagent` tool takes
// `model` as `providerID/modelID` (or `providerID/modelID#variant`), so the
// plugin's execute.before sets the role's model on a fresh spawn, the same
// choice Claude Code's hook makes (core/role-models.ts chooseSpawnModel). A
// continuation (input `sessionID`) keeps its child's model. The lead learns
// what changed on its next turn, through the session context hook. A subagent
// whose result or error is a usage limit marks its provider exhausted (#655):
// the next spawn of its role falls back, and the lead is told to re-dispatch
// it once. A lead on an exhausted provider gets a one-line switch notice.
import {
  chooseSpawnModel,
  leadSwitchNotice,
  resolveRoleModel,
  roleForAgentType,
} from "@brainervirus/workit-core/src/core/role-models";
import { recordUsageLimit, redispatchNote } from "@brainervirus/workit-core/src/hooks/model-limit";

/** What the subagent tool's `model` takes: `providerID/modelID`, optionally `#variant`. */
const opencodeSubagentModel = (value: string): string | null => {
  const trimmed = value.trim();
  return /^[^\s/#]+\/[^\s#]+(?:#\S+)?$/u.test(trimmed) ? trimmed : null;
};

/** Notes for a lead session, delivered on its next context build. */
export type SpawnNotes = Map<string, string[]>;

export const applySpawnModel = (
  root: string,
  event: { sessionID: string; input: unknown },
  notes: SpawnNotes,
): void => {
  const input = event.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const fields = input as Record<string, unknown>;
  if (fields.sessionID !== undefined) return;
  const selector = roleForAgentType(fields.agent, fields.prompt);
  if (!selector) return;
  const choice = chooseSpawnModel(
    root,
    selector,
    "opencode",
    { model: fields.model },
    opencodeSubagentModel,
  );
  // In place: the host runs the tool with the object this hook received.
  if (choice.model) fields.model = choice.model;
  if (choice.note) notes.set(event.sessionID, [...(notes.get(event.sessionID) ?? []), choice.note]);
};

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/**
 * A failed subagent call: when its error is a usage limit, mark
 * the provider of the model it ran on exhausted and queue the re-dispatch
 * note for the lead session.
 */
export const observeSubagentLimit = (
  root: string,
  event: {
    sessionID: string;
    input: unknown;
    result?: unknown;
    error?: unknown;
  },
  notes: SpawnNotes,
): void => {
  const fields =
    event.input && typeof event.input === "object" && !Array.isArray(event.input)
      ? (event.input as Record<string, unknown>)
      : {};
  // Only a failed call: a finished worker's own report may discuss limits.
  const text = textOf(event.error);
  if (!text) return;
  const selector = roleForAgentType(fields.agent, fields.prompt);
  const model =
    typeof fields.model === "string" && fields.model.trim()
      ? fields.model
      : selector
        ? (resolveRoleModel(root, selector, "opencode")?.model ?? null)
        : null;
  const seen = recordUsageLimit(text, { cwd: root, host: "opencode", model });
  if (!seen) return;
  const note = redispatchNote(seen, {
    label: `subagent ${typeof fields.agent === "string" ? fields.agent : "general"}`,
    prompt: typeof fields.prompt === "string" ? fields.prompt : null,
  });
  notes.set(event.sessionID, [...(notes.get(event.sessionID) ?? []), note]);
};

/** Sessions already told to switch, keyed by session and reset time. */
export type SwitchNotices = Set<string>;

/** Once per exhaustion: tell a lead on an exhausted provider to switch its model. */
export const injectLeadSwitch = (
  root: string,
  sessionID: string,
  model: string | null,
  told: SwitchNotices,
  system: Array<{ type: "text"; text: string }>,
): void => {
  const notice = leadSwitchNotice(root, "opencode", model);
  if (!notice) return;
  const key = `${sessionID}\0${notice}`;
  if (told.has(key)) return;
  told.add(key);
  system.push({ type: "text", text: `<workit-note>${notice}</workit-note>` });
};

/** Push and clear the spawn notes waiting for `sessionID`. */
export const injectSpawnNotes = (
  notes: SpawnNotes,
  sessionID: string,
  system: Array<{ type: "text"; text: string }>,
): void => {
  const pending = notes.get(sessionID);
  if (!pending) return;
  notes.delete(sessionID);
  for (const text of pending)
    system.push({ type: "text", text: `<workit-note>${text}</workit-note>` });
};
