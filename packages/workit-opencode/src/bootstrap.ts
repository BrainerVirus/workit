import { invariantBootstrap } from "@workit-dev/core/src/core";

/** OpenCode's host addendum, in the slot Claude Code's SessionStart gives its own. */
export const OPENCODE_ADDENDUM =
  "On OpenCode, run external mutations with native host tools or the workit CLI; workit_context is read-only and there is no managed external-action executor, so do not create proposals or request Workit approvals merely to invoke native tools. Record a meaningful user choice with workit_decision directly; it needs no question.";

let cached: string | null | undefined;

/** The contract in the same closed `<workit-contract>` block Claude Code renders (#793). */
export const getWorkitBootstrap = (): string | null => {
  if (cached !== undefined) return cached;
  cached = `<workit-contract>\n${invariantBootstrap()}\n${OPENCODE_ADDENDUM}\n</workit-contract>`;
  return cached;
};
