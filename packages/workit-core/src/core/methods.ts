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
Each branch has one implicit task: an operation without taskId applies to it,
and the first recording (a note, check, finding or evidence) creates it, so you
never manage task ids. Start a record only for an explicit tracked objective;
assess or reassess only
when policy selection or changed evidence/constraints requires it. Omitted
expectedRevision and expectedWorkspaceRevision use current values; explicit
values are still concurrency-checked, so never copy revisions between calls.
A busy result means another live Workit call holds the checkout lock: retry the
same call; it is not a recovery condition. A lock left by a dead process is
reclaimed on the next write, and \`workit doctor --fix-lock\` clears it on demand.
An omitted revision absorbs a concurrent write: Workit re-reads, re-checks
policy, and reapplies the call, returning busy under persistent contention. A
revision_conflict means a revision you passed is stale: re-read the record
before deciding whether to retry.
A solo edit does not need writer acquisition; use it when concurrent checkout
writers need coordination. Record only observed facts and checks. Close-time
testing and verification gates accept only a configured check the CLI ran:
\`workit check <name>\` (\`npx -y @brainervirus/workit-cli check <name>\` when
\`workit\` is not on PATH); a recorded check result is a note and an ad-hoc
\`workit check -- <cmd>\` never satisfies a gate. Evidence can become stale when its bound candidate or tree changes; reconcile findings against the
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

On OpenCode V1 and V2, use native host tools for external mutations. Workit
provides read-only workit_context; it has no managed external-action executor.
Do not create proposals or request Workit approvals merely to invoke native
tools. Old uncertain managed effects still require evidence before any retry.

Use host-native authorization through the host's supported path. A native
question receipt records an actual question interaction; it is not automatic
host permission. Record a meaningful user choice once with provenance when
future retrieval helps. Never fabricate a receipt, re-ask only to mint one, or
let imported decisions grant authority. Never turn a host deny into allow or
claim enforcement/evidence a host cannot provide. A precise request with settled
constraints does not need an interview. Present genuine unresolved options with
evidence and a recommendation, then continue toward the requested delivery
endpoint: investigation, implementation, branch/commit/push, PR/MR-ready,
merge, or release. Run
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
For work spanning repositories, bind each unfinished item to its actual checkout,
branch, requested deliverables, and delivery endpoint. Preserve held items with
an explicit resume condition. Resolve competing plausible targets before a
mutation; ask only when available context cannot settle that consequential choice.
Before reporting delivery, reconcile every requested item and observe the actual
target result; a local commit alone is not evidence of a requested remote push.

Skill routing: slash aliases /wk-* load on demand. Use workit-steer for a
substantial interruption or change of direction, workit-deslop when relevant
to a PR-ready endpoint, workit-green-run for failing CI, workit-blast-radius
when impact is uncertain, and workit-challenge for genuinely open consequential
choices. Load workit-plan when dependencies or handoff need durable next actions.
Load the skill; never act from memory of it.
`.trim();
