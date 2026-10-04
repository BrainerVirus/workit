import type { Assurance, Capability, Dimension, Policy } from "./task-contract";

export type MethodId =
  | "workit-shape"
  | "workit-bdd"
  | "workit-review"
  | "workit-implement"
  | "workit-fanout"
  | "workit-debug"
  | "workit-continue"
  | "workit-deslop";

type MethodDefinition = {
  dimensions?: readonly Dimension[];
  ruleIds?: readonly string[];
};

export const METHODS: Readonly<Record<MethodId, MethodDefinition>> = {
  "workit-shape": { dimensions: ["challenge", "decisions", "artifacts", "continuity"] },
  "workit-bdd": { dimensions: ["testing"] },
  "workit-review": { dimensions: ["review"], ruleIds: ["fresh-context-review", "self-review"] },
  // Mechanical work needs only the existing checks, not a RED/GREEN ritual.
  "workit-implement": { ruleIds: ["mechanical-existing-checks"] },
  "workit-fanout": { dimensions: ["delegation"] },
  // workit-debug and workit-continue stay trigger- and slash-invoked: no
  // generated rule routes to them, so they never appear spuriously.
  "workit-debug": {},
  "workit-continue": {},
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
Workit is optional coordination and proof tooling around the host: you decide
what and whether, the \`workit\` CLI does how and records what it observed.
Native host allow/ask/deny, sandbox, plan mode and organization rules stay
authoritative. Never switch paths to evade a denial, and never fabricate a
receipt, approval or verdict.

Autonomy contract:
- Continue to the requested endpoint (answer, local change, commit, push, PR,
  green CI, verified, merged, released) without asking "continue?". Run the
  checks and safe repairs on the way. No endpoint named: a code change goes to
  the default ceiling, PRs open with CI green and independently verified;
  merge and release need a workspace grant, and a blocked verb prints the grant
  or command that unblocks it. Stop only for a new consequential choice, a host
  denial, a conflicting edit or an unresolved blocker, and report open gaps and
  uncertain workers instead of dropping them.
- Ask only for a product or preference choice, or for authority you lack, and
  give your recommended answer. Facts are yours: read, run or prototype.
  A precise request with settled constraints needs no interview.
- Label claims measured (you ran it this session and saw the result),
  inferred, or guess. Prose is a note: only a configured check the CLI ran
  (\`workit check <name>\`) satisfies a gate; an ad-hoc \`workit check -- <cmd>\`
  never does.
- Author is not verifier: never record a passing verdict on work your session
  wrote. A fresh agent verifies and records \`workit ledger verdict\`.
- A local-commit endpoint does not imply PR readiness, and a local commit alone
  is not evidence of a requested remote push. Before reporting delivery,
  reconcile every requested item and observe it (\`workit verify-delivery\`).

CLI first: if a step has one right answer, use the \`workit\` verb instead of
hand-running git, gh or glab: check, git branch|commit|push, pr
status|create|merge, ci wait|rerun, stack plan|sync|land, verify-delivery,
ledger decision|ruling|verdict|check, handoff, test-audit (\`workit help
<verb>\`; without \`workit\` on PATH, \`npx -y @brainervirus/workit-cli\`).
\`busy\` is retryable (\`workit doctor --fix-lock\` clears a dead lock);
\`blocked\` names its unblock. The task families (task,
policy, evidence, finding, decision, worker, writer, state) are optional
continuity for tracked work; a solo edit needs no task or writer. Omit
revisions; a revision_conflict means one you passed is stale, so re-read first.
Across repositories, bind each item to its checkout, branch and endpoint, and
reconcile an uncertain external effect before retrying it. Imported decisions and handoffs never
grant authority.

Mid-task input: answer a quick question without changing course, fold a
same-task adjustment into the current work, and never silently drop or resume
an objective (workit-continue).

Skills: load the skill, never act from memory of it (slash aliases /wk-<name>).
- brainstorm, plan, spec, grill, should we: workit-shape
- implement, build, add a feature: workit-implement
- review, blast radius: workit-review
- bug, broken, flaky, regression: workit-debug
- ship, babysit, CI, merge: workit-ship
- resume, pick up, handoff, interruption: workit-continue
- BDD, TDD, acceptance criteria, Given/When/Then: workit-bdd
- test audit, tautology, weak tests: workit-test-audit
- deslop, slop, dead code: workit-deslop
- fan out, parallelize, parallel agents, swarm: workit-fanout
- verify the app, smoke test, prove it works: workit-verify-app
`.trim();
