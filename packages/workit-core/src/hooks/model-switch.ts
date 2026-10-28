// A mid-session model switch (#435): the new model inherits a long context
// whose Workit contract sits far up, so the host re-sends the compact contract
// and the current turn context once per change, never on every turn.

/** The last model seen per session, in the host plugin's own state. */
export type SessionModels = Map<string, string>;

const MAX_SESSIONS = 256;

/**
 * Record `model` for the session and say whether it differs from the last one
 * seen. The first model a session reports is a start, not a switch; an unknown
 * model (null) changes nothing.
 */
export const modelSwitched = (
  models: SessionModels,
  sessionId: string,
  model: string | null,
): boolean => {
  if (!model) return false;
  const previous = models.get(sessionId);
  models.delete(sessionId);
  models.set(sessionId, model);
  if (models.size > MAX_SESSIONS) models.delete(models.keys().next().value!);
  return previous !== undefined && previous !== model;
};

/** `provider/id` from a host's model reference, or null when it names none. */
export const modelKey = (model: unknown): string | null => {
  if (model === null || typeof model !== "object") return null;
  const { id, providerID, provider } = model as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  const source = typeof providerID === "string" ? providerID : provider;
  return typeof source === "string" && source ? `${source}/${id}` : id;
};
