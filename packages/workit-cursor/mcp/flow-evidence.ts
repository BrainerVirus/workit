import {
  createCursorConfirmation,
  type EvidenceResult,
  type MutationContext,
} from "@brainervirus/workit-core/src/core/flow-state";

/**
 * Cursor question adapter (CA-42): the Cursor MCP cannot observe the
 * AskQuestion result (registerTool receives only tool arguments), so it never
 * fabricates a host-observed answer. Every confirmation is the policy-only
 * constant `{ host: "cursor", attested: false, confirmation: "contract" }` —
 * unauthenticated by design, carrying no caller-supplied question data. The
 * tool schemas expose no evidence argument; this adapter takes no input.
 */
export const cursorQuestionEvidence = (): EvidenceResult => createCursorConfirmation();

export const CURSOR_HOST = "cursor" as const;

/**
 * Cursor MutationContext (FG-05, CA-21). The Cursor MCP has no per-session
 * identity (registerTool receives only tool arguments), so the session id is a
 * deterministic value derived from the workspace root + host constant: every
 * request against the same repo is attributed to the same stable session, and
 * nothing machine-generated crosses a repo boundary. Cursor has no delegated
 * workers (no subagent-driven `task` flow), so every Cursor mutation is the
 * coordinator session. Fail-closed by construction: role/taskIdentity are
 * never accepted as tool args on the Cursor MCP — a client-supplied role would
 * let the model self-certify as a delegated worker and re-open the boundary.
 */
export const cursorMutationContext = (workspaceRoot: string): MutationContext => ({
  hostWorkspace: workspaceRoot,
  role: "coordinator",
  sessionId: `${CURSOR_HOST}:${workspaceRoot}`,
  taskIdentity: undefined,
});
