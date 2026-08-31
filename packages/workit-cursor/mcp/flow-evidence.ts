import {
  createCursorConfirmation,
  validateDelegateToken,
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
 * Cursor mutation identity (FG-05, CA-21, cursor-subagent-inline CA-03/CA-04).
 * Without a delegation token the context is the deterministic coordinator
 * session (hostWorkspace + host constant): the MCP has no per-session identity,
 * so every tokenless request against the same repo is attributed to the same
 * stable session. With a token, the token is validated through the core helper
 * BEFORE any context is built: only a valid active token bound to this
 * workspace yields the delegated context (`role: "delegated"`, `taskIdentity`
 * String(active_task_id)). A missing-but-supplied, invalid, revoked, or
 * wrong-workspace token returns a structured failure and NEVER a coordinator
 * context — no silent downgrade (fail closed).
 */
export type CursorMutationIdentity =
  | { ok: true; context: MutationContext }
  | { ok: false; code: string; error: string };

/** The deterministic coordinator context, for coordinator-only tools. */
export const cursorCoordinatorContext = (workspaceRoot: string): MutationContext => ({
  hostWorkspace: workspaceRoot,
  role: "coordinator",
  sessionId: `${CURSOR_HOST}:${workspaceRoot}`,
  taskIdentity: undefined,
});

export const cursorMutationContext = (
  workspaceRoot: string,
  delegationToken?: string,
): CursorMutationIdentity => {
  if (delegationToken === undefined) {
    return { ok: true, context: cursorCoordinatorContext(workspaceRoot) };
  }
  const validated = validateDelegateToken(workspaceRoot, delegationToken);
  if (!validated.ok) {
    return { ok: false, code: validated.code, error: validated.error };
  }
  return {
    ok: true,
    context: {
      hostWorkspace: workspaceRoot,
      role: "delegated",
      sessionId: `${CURSOR_HOST}:${workspaceRoot}:task-${validated.context.taskId}`,
      taskIdentity: String(validated.context.taskId),
    },
  };
};
