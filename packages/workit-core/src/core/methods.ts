import type { Assurance, Capability, Dimension, Policy } from "./task-contract";

export type MethodId =
  | "workit-challenge"
  | "workit-behavioral-tdd"
  | "workit-review"
  | "workit-plan"
  | "workit-implement"
  | "workit-debug"
  | "workit-handoff";

type MethodDefinition = {
  dimensions?: readonly Dimension[];
  ruleIds?: readonly string[];
};

export const METHODS: Readonly<Record<MethodId, MethodDefinition>> = {
  "workit-challenge": { dimensions: ["challenge", "decisions"] },
  "workit-behavioral-tdd": { dimensions: ["testing"] },
  "workit-review": { dimensions: ["review"] },
  "workit-plan": { dimensions: ["artifacts", "continuity"] },
  "workit-implement": { dimensions: ["delegation"] },
  "workit-debug": { ruleIds: ["root-cause-investigation"] },
  "workit-handoff": { ruleIds: ["durable-handoff"] },
};

export type SelectedMethod = {
  id: MethodId;
  reason: string;
  assurance: Assurance;
};

const methodMatches = (
  id: MethodId,
  definition: MethodDefinition,
  requirement: Policy["requirements"][number],
): boolean =>
  (definition.dimensions?.includes(requirement.dimension) === true &&
    !(id === "workit-review" && requirement.ruleId === "self-review")) ||
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
      methodMatches(id, definition, requirement),
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
Workit keeps one accountable lead and one shared task state. Inspect current task
state before acting. An empty task.list means no session yet, not permission to
skip Workit; for user-requested product, debug, or behavior work with no active
or paused task, run task.start then policy.assess before other product mutations.
Use only the shared operations for task, policy, evidence, finding, decision,
worker, writer, and state changes. Authority is bounded by the requested scope,
current revision, caller/session provenance, and observed capabilities. Never
claim host enforcement or evidence that the host cannot provide. Preserve
unresolved requirements, gaps, and uncertain workers.
`.trim();
