import { shellPolicy } from "@brainervirus/workit-core/hooks";

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
    const decision = shellPolicy(root, resource);
    if (decision.kind === "deny") {
      event.effect = "deny";
      event.message = decision.reason;
      return;
    }
  }
};
