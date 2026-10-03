import { shellBranchPolicyViolation } from "../core/route-intent";
import type { HookDecision } from "./protocol";

/**
 * Branch policy for one shell command: only direct literal branch creation
 * onto a noncompliant name is denied. Every other command keeps the host's own
 * permission decision. The reason carries the policy's correction.
 */
export const shellPolicy = (cwd: string, command: string): HookDecision => {
  const policy = shellBranchPolicyViolation(cwd, command);
  return policy && !policy.ok
    ? { kind: "deny", reason: `branch_policy_denied: ${policy.error}`, unblock: null }
    : { kind: "none" };
};
