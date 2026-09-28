import { shellBranchPolicyViolation } from "@brainervirus/workit-core/src/core";

export type PermissionEvaluationEvent = {
  action: string;
  resources: ReadonlyArray<string>;
  effect: string;
  message?: string;
};

/**
 * Validate only direct literal branch-creation commands. Compliant branches,
 * PR commands, worktrees, and other shell forms keep the host's decision.
 */
export const evaluateShellPermission = (root: string, event: PermissionEvaluationEvent): void => {
  if (event.action !== "shell" || event.effect === "deny") return;
  for (const resource of event.resources) {
    if (typeof resource !== "string") continue;
    const policy = shellBranchPolicyViolation(root, resource);
    if (policy && !policy.ok) {
      event.effect = "deny";
      event.message = `branch_policy_denied: ${policy.error}`;
      return;
    }
  }
};
