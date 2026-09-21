import { shouldDenyShellRoute } from "@brainervirus/workit-core/src/core";

/** The V1 config rule was the glob `*git *worktree*`; the V2 evaluate hook
 * applies the same matcher: a literal `git ` followed later by `worktree`. */
const GIT_WORKTREE = /git [\s\S]*worktree/u;

const WORKTREE_MESSAGE =
  "Workit does not use git worktrees; use the guarded in-place git.branch_setup route instead";

export type PermissionEvaluationEvent = {
  action: string;
  resources: ReadonlyArray<string>;
  effect: string;
  message?: string;
};

/**
 * Workit shell rules on the V2 permission evaluate hook: recognized direct
 * branch/PR creation is denied with the exact Workit route while a live task
 * exists, and a git worktree command is always denied. Explicit configured
 * denies stay final; unparseable or unrelated commands keep their allow/ask
 * decision.
 */
export const evaluateShellPermission = (root: string, event: PermissionEvaluationEvent): void => {
  if (event.action !== "shell" || event.effect === "deny") return;
  for (const resource of event.resources) {
    if (typeof resource !== "string") continue;
    const route = shouldDenyShellRoute(root, resource);
    if (route) {
      event.effect = "deny";
      event.message = `direct branch or PR creation bypasses the Workit route; ${route.guidance}`;
      return;
    }
    if (GIT_WORKTREE.test(resource)) {
      event.effect = "deny";
      event.message = WORKTREE_MESSAGE;
      return;
    }
  }
};
