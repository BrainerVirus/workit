// What Workit tells an agent about git, by role: one source for the
// SubagentStart text (handle.ts) and the raw-git nudge set (raw-git.ts), so
// the two cannot disagree (#428).
import { gateCheckNames, loadCheckConfig } from "../check-config";
import { neededChecks } from "../core/policy/check-evidence";
import type { HostDescriptor } from "./descriptor";
import { hostIsolated } from "./worktree-confine";

export type WorkitRole = "implementer" | "judge";

const ROLES: Readonly<Record<string, WorkitRole>> = {
  implementer: "implementer",
  verifier: "judge",
  reviewer: "judge",
};

/**
 * The Workit agent role an agent type names, spelled the host's way
 * (`descriptor.subagents.agentPrefix`): Claude Code namespaces plugin agents
 * (`workit:implementer`, so a bare `workit-implementer` is someone else's);
 * other hosts name custom agents freely (`workit-implementer`).
 */
export const workitRole = (descriptor: HostDescriptor, agentType: string): WorkitRole | null => {
  const prefix = descriptor.subagents.agentPrefix;
  const name = agentType.startsWith(prefix) ? agentType.slice(prefix.length) : "";
  return Object.hasOwn(ROLES, name) ? ROLES[name] : null;
};

/** A Claude Code worktree path: `<repo>/.claude/worktrees/<name>`. */
const CLAUDE_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/;

export type RoleSteering = {
  role: WorkitRole | null;
  /** The host put the agent in its own worktree. */
  isolated: boolean;
  /** How the start text tells it to run git: `plain` (host isolation refuses a wrapper), `workit`, or not at all. */
  git: "plain" | "workit" | null;
  /** Raw commit/push/PR-create nudges: only for an agent no start text told how to run git. */
  nudges: boolean;
};

export const roleSteering = (role: WorkitRole | null, isolated: boolean): RoleSteering => ({
  role,
  isolated,
  git: role === "implementer" ? (isolated ? "plain" : "workit") : null,
  // An implementer has its git line already; a judge does not commit.
  nudges: role === null,
});

/** The steering for one agent, as the host names it (no agent type: the lead). */
export const agentSteering = (
  descriptor: HostDescriptor,
  cwd: string,
  agent: { type: string | null; id: string | null },
): RoleSteering => {
  const role = agent.type ? workitRole(descriptor, agent.type) : null;
  // An implementer is host-isolated only when the host put it in its own
  // worktree (`.claude/worktrees/agent-<id>`); by default the lead makes one.
  const isolated =
    descriptor.subagents.worktreeIsolation === "native" &&
    (role === "implementer" ? hostIsolated(cwd, agent.id) : CLAUDE_WORKTREE.test(cwd));
  return roleSteering(role, isolated);
};

/**
 * The configured checks a judge runs before a verified verdict, as exact
 * commands: `ledger verdict` refuses one while any is missing or red on the
 * head (#509). Null when the repository configures none.
 */
export const judgeChecksLine = (cwd: string): string | null => {
  const names = neededChecks("full", gateCheckNames(loadCheckConfig(cwd), "verification"));
  if (!names.length) return null;
  return `Before a verified or tests-verified verdict, run each configured check on the candidate head, by name and one per call: ${names.map((name) => `\`workit check ${name}\``).join(", ")} (with \`--cwd <checkout>\` when the candidate is checked out elsewhere). The verdict is refused while any of them has no fresh passing run on that head; an ad-hoc \`workit check -- <cmd>\` does not stand in for one.`;
};
