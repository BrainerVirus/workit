import { invariantBootstrap } from "@workit-dev/core/src/core";

/** OpenCode's host addendum, in the slot Claude Code's SessionStart gives its own. */
export const OPENCODE_ADDENDUM =
  "On OpenCode, run external mutations with native host tools or the workit CLI; workit_context is read-only and there is no managed external-action executor, so do not create proposals or request Workit approvals merely to invoke native tools. Record a meaningful user choice with workit_decision directly; it needs no question.";

const cached = new Map<string, string>();

/**
 * The contract in the same closed `<workit-contract>` block Claude Code
 * renders (#793), for the session's directory: a workspace with
 * `feedback: "off"` drops the feedback line (#777). Built once per directory.
 */
export const getWorkitBootstrap = (cwd: string = process.cwd()): string | null => {
  const hit = cached.get(cwd);
  if (hit !== undefined) return hit;
  const block = `<workit-contract>\n${invariantBootstrap({ cwd, host: "opencode" })}\n${OPENCODE_ADDENDUM}\n</workit-contract>`;
  cached.set(cwd, block);
  return block;
};
