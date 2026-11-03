// Role models on an OpenCode subagent spawn (#654): the `subagent` tool takes
// `model` as `providerID/modelID` (or `providerID/modelID#variant`), so the
// plugin's execute.before sets the role's model on a fresh spawn, the same
// choice Claude Code's hook makes (core/role-models.ts chooseSpawnModel). A
// continuation (input `sessionID`) keeps its child's model. The lead learns
// what changed on its next turn, through the session context hook.
import { chooseSpawnModel, roleForAgentType } from "@brainervirus/workit-core/src/core/role-models";

/** What the subagent tool's `model` takes: `providerID/modelID`, optionally `#variant`. */
export const opencodeSubagentModel = (value: string): string | null => {
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
