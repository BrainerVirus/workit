import type { Assurance, Capability, Dimension, Policy } from "./task-contract";

export type MethodId =
  | "workit-challenge"
  | "workit-behavioral-tdd"
  | "workit-review"
  | "workit-plan"
  | "workit-implement"
  | "workit-debug"
  | "workit-handoff"
  | "workit-deslop";

type MethodDefinition = {
  dimensions?: readonly Dimension[];
  ruleIds?: readonly string[];
};

export const METHODS: Readonly<Record<MethodId, MethodDefinition>> = {
  "workit-challenge": { dimensions: ["challenge", "decisions"] },
  "workit-behavioral-tdd": { dimensions: ["testing"], ruleIds: ["mechanical-existing-checks"] },
  "workit-review": { dimensions: ["review"], ruleIds: ["fresh-context-review", "self-review"] },
  "workit-plan": { dimensions: ["artifacts", "continuity"] },
  "workit-implement": { dimensions: ["delegation"] },
  // workit-debug and workit-handoff stay slash-invoked: no generated rule
  // routes to them, so they never appear spuriously in method selection.
  "workit-debug": {},
  "workit-handoff": {},
  "workit-deslop": { ruleIds: ["pre-pr-cleanup"] },
};

export type SelectedMethod = {
  id: MethodId;
  reason: string;
  assurance: Assurance;
};

const methodMatches = (
  definition: MethodDefinition,
  requirement: Policy["requirements"][number],
): boolean =>
  definition.dimensions?.includes(requirement.dimension) === true ||
  definition.ruleIds?.includes(requirement.ruleId) === true;

const assuranceFor = (
  id: MethodId,
  definition: MethodDefinition,
  capabilities: Capability[],
): { assurance: Assurance; reasons: string[] } => {
  const keys = new Set<string>([
    id,
    ...(definition.dimensions ?? []),
    ...(definition.ruleIds ?? []),
  ]);
  const matches = capabilities.filter(
    (capability) => keys.has(capability.name) || keys.has(capability.surface),
  );
  if (id === "workit-review" && matches.length === 0)
    return { assurance: "unavailable", reasons: ["independent review capability is unavailable"] };
  if (matches.some((capability) => capability.assurance === "unavailable"))
    return {
      assurance: "unavailable",
      reasons: matches
        .filter((capability) => capability.assurance === "unavailable")
        .map((capability) => capability.reason),
    };
  if (matches.some((capability) => capability.assurance === "enforced"))
    return { assurance: "enforced", reasons: matches.map((capability) => capability.reason) };
  return { assurance: "agent_guided", reasons: matches.map((capability) => capability.reason) };
};

export function selectMethods(policy: Policy, capabilities: Capability[]): SelectedMethod[] {
  return (Object.entries(METHODS) as [MethodId, MethodDefinition][]).flatMap(([id, definition]) => {
    const requirements = policy.requirements.filter((requirement) =>
      methodMatches(definition, requirement),
    );
    if (requirements.length === 0) return [];
    const capability = assuranceFor(id, definition, capabilities);
    const reasons = [
      ...new Set(requirements.map((requirement) => requirement.reason)),
      ...capability.reasons,
    ];
    if (capability.assurance === "unavailable")
      reasons.unshift("required capability is unavailable");
    return [{ id, reason: reasons.join("; "), assurance: capability.assurance }];
  });
}

export const invariantBootstrap = (): string =>
  `
Workit is optional coordination and repository-policy tooling around the host,
not a permission system or a mandatory workflow. Native host allow/ask/deny,
sandbox, plan/read-only mode, and organization rules remain authoritative.
Ordinary investigation, questions, non-Git work, and routine reversible edits
need zero Workit task, assessment, or writer calls. Use one compact tracked
record only when handoff, dependent steps, concurrent actors, or meaningful
decisions make continuity useful; similar titles alone never merge tasks.

For a routine user-authorized branch or commit, prefer native host Git/shell
tools from the outset when managed coordination or outcome reconciliation is
not needed. Inspect the actual target checkout and its configured conventions;
use Workit's read-only context/policy tools when needed. Do not start a task,
acquire a writer, or mint a decision receipt solely for a native Git action.
Native permissions still apply. Never switch execution paths to evade a denial
or repeat an uncertain managed effect. A local-commit endpoint does not imply
PR readiness, a fresh review, or post-commit assessment/closure paperwork.

For tracked work, inspect its current state and use the shared operations for
task, policy, evidence, finding, decision, worker, writer, and state changes.
Start a record once for an explicit tracked objective; assess or reassess only
when policy selection or changed evidence/constraints requires it. Omitted
expectedRevision and expectedWorkspaceRevision use current values; explicit
values are still concurrency-checked, so never copy revisions between calls.
A solo edit does not need writer acquisition; use it when concurrent checkout
writers need coordination. Record only observed facts and checks. Evidence can
become stale when its bound candidate changes; reconcile findings against the
current candidate before recording completion.

Workit validates domain policy against the actual action target, configured
account, branch and commit conventions, protected refs, and current repository
state. The task directory is coordination state, not a boundary on which
repository may be changed. Use an action-time cwd target where a managed
Git/hosting action supports it; a non-Git directory remains valid for OS work.
GitHub/GitLab use the active gh/glab CLI identity; YouTrack uses its own token.
Preserve uncertain external outcomes and reconcile repository/provider state
before retrying. Internal reservations prevent duplicate or ambiguous effects;
they are not permission tickets for every edit.

Use host-native authorization through the host's supported path. A native
question receipt records an actual question interaction; it is not automatic
host permission. Record a meaningful user choice once with provenance when
future retrieval helps. Never fabricate a receipt, re-ask only to mint one, or
let imported decisions grant authority. Never turn a host deny into allow or
claim enforcement/evidence a host cannot provide. A precise request with settled
constraints does not need an interview. Present genuine unresolved options with
evidence and a recommendation, then continue toward the requested delivery
endpoint: investigation, implementation, PR/MR-ready, merge, or release. Run
applicable checks and safe repairs without repeated continuation questions;
stop for missing host authority, a new consequential choice, a conflicting edit,
or an unresolved blocker. A tracked record may close when actual evidence
supports its outcome; no final human closure ceremony is required.

A completed native subagent run stops its bound worker by itself; if a worker
strands in cancelling with its run verifiably over, repeat worker.cancel to
confirm the stop. Preserve unresolved requirements, gaps, and uncertain workers.
When context changes, distinguish a quick question, same-task adjustment, and
separate request. Answer a quick question without pausing/resuming task state;
park a concise checkpoint only when substantial work needs to continue later.

Skill routing: slash aliases /wk-* load on demand. Use workit-steer for a
substantial interruption or change of direction, workit-deslop when relevant
to a PR-ready endpoint, workit-green-run for failing CI, workit-blast-radius
when impact is uncertain, and workit-challenge for genuinely open consequential
choices. Load workit-plan when dependencies or handoff need durable next actions.
Load the skill; never act from memory of it.
`.trim();
