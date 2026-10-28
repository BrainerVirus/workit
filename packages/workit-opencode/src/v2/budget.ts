// The worker tool-call budget on OpenCode (hooks/budget-signal.ts): a lead's
// `subagent` call whose prompt names `N tool calls` queues N; the child binds
// it on its first tool call and every call of it is counted. The line rides
// the child's system context (injection.ts) while the budget stands reached.
import {
  claimSpawnBudget,
  noteSpawnBudget,
  tickBudget,
} from "@brainervirus/workit-core/src/hooks/budget-signal";

const claimed = new Set<string>();

export const observeBudget = (
  root: string,
  event: { tool: string; sessionID: string; input: unknown },
  children: ReadonlyMap<string, string>,
): void => {
  try {
    const parent = children.get(event.sessionID);
    if (parent) {
      if (!claimed.has(event.sessionID)) {
        claimed.add(event.sessionID);
        claimSpawnBudget(root, parent, event.sessionID, null);
      }
      tickBudget(root, parent, event.sessionID);
      return;
    }
    if (event.tool !== "subagent" || !event.input || typeof event.input !== "object") return;
    const prompt = Object.values(event.input).find(
      (field): field is string => typeof field === "string" && field.includes("TIMEBOX:"),
    );
    if (prompt) noteSpawnBudget(root, event.sessionID, null, prompt);
  } catch {
    // Fail open: the worker runs unbudgeted.
  }
};
