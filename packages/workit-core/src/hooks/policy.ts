import { shellBranchPolicyViolation } from "../core/route-intent";
import type { HookDecision } from "./protocol";
import type { ShellDialect } from "./shell-words";

/**
 * Branch policy for one shell command: a raw branch creation (`git switch -c`,
 * `checkout -b`, `branch`, `worktree add -b`, in any chain, directory or
 * wrapper) onto a noncompliant name is denied. Every other command keeps the
 * host's own permission decision. The reason carries the policy's correction.
 */
export const shellPolicy = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision => {
  const policy = shellBranchPolicyViolation(cwd, command, dialect);
  return policy && !policy.ok
    ? { kind: "deny", reason: `branch_policy_denied: ${policy.error}`, unblock: null }
    : { kind: "none" };
};
