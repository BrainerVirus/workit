import { shellBranchPolicyViolation } from "../core/route-intent";
import type { HookDecision } from "./protocol";
import { analysisDenial } from "./raw-git";
import { ShellAnalysisError, type ShellDialect } from "./shell-words";

/**
 * Branch policy for one shell command: a raw branch creation (`git switch -c`,
 * `checkout -b`, `branch`, `worktree add -b`, in any chain, directory or
 * wrapper) onto a noncompliant name is denied. Every other command keeps the
 * host's own permission decision. The reason carries the policy's correction.
 * A command the hook cannot analyze is denied with how to split it; any other
 * failure propagates to the host's fail policy.
 */
export const shellPolicy = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision => {
  let policy: ReturnType<typeof shellBranchPolicyViolation>;
  try {
    policy = shellBranchPolicyViolation(cwd, command, dialect);
  } catch (error) {
    if (error instanceof ShellAnalysisError) return analysisDenial(error);
    throw error;
  }
  return policy && !policy.ok
    ? { kind: "deny", reason: `branch_policy_denied: ${policy.error}`, unblock: null }
    : { kind: "none" };
};
