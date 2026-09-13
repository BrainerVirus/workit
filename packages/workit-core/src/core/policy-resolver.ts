import * as z from "zod";
import {
  assessmentSchema,
  canonicalJson,
  constraintSchema,
  decisionSchema,
  failure,
  findingSchema,
  intentSchema,
  POLICY_VERSION,
  policyChangeSchema,
  policySchema,
  requirementId,
  requirementSchema,
  sha256,
  success,
  type Assessment,
  type Constraint,
  type Decision,
  type Dimension,
  type Finding,
  type Intent,
  type Policy,
  type PolicyChange,
  type Requirement,
  type Result,
  type Scope,
} from "./task-contract";

export type ResolverPrior = {
  decisions: Decision[];
  findings: Finding[];
  requirements: Requirement[];
};

export type ResolverPreferences = {
  fast?: boolean;
  thorough?: boolean;
};

/** Size facts for deterministic spec triage (op1 with override). */
export type TriageFacts = {
  /** New or changed observable behavior. */
  newOrChangedBehavior: boolean;
  /** Open ambiguity needing user resolution. */
  ambiguityOpen: boolean;
  /** Cross-package/host contract, auth/data/security surface, or irreversible migration. */
  crossContract: boolean;
  /** Subsystems touched. */
  subsystems: number;
  /** Packages touched (a 2-package change is Large even in one subsystem). */
  packagesTouched: number;
  /** Estimated implementation steps. */
  steps: number;
};

export type TriageTier = "spec-plan" | "plan-only" | "neither";

/** Large → spec + full plan; Medium → compact plan-only; Small → neither.
 * Step count alone never escalates: a long but known, single-subsystem run
 * stays plan-only. The lead may re-tier with a reason recorded in progress
 * (override). */
export const triageTier = (facts: TriageFacts): TriageTier => {
  if (
    facts.newOrChangedBehavior ||
    facts.ambiguityOpen ||
    facts.crossContract ||
    facts.subsystems >= 3 ||
    facts.packagesTouched >= 2
  )
    return "spec-plan";
  if (facts.steps >= 2) return "plan-only";
  return "neither";
};

/** Tier → assessor signal values (durableAgreementNeeded, coordinationPlanNeeded). */
export const triageSignals = (
  tier: TriageTier,
): { durableAgreementNeeded: boolean; coordinationPlanNeeded: boolean } =>
  tier === "spec-plan"
    ? { durableAgreementNeeded: true, coordinationPlanNeeded: true }
    : tier === "plan-only"
      ? { durableAgreementNeeded: false, coordinationPlanNeeded: true }
      : { durableAgreementNeeded: false, coordinationPlanNeeded: false };

export type ResolverInput = {
  intent: Intent;
  assessment: Assessment;
  constraints: Constraint[];
  prior: ResolverPrior;
  preferences?: ResolverPreferences;
};

type NormalizedResolverInput = ResolverInput & { policyVersion: typeof POLICY_VERSION };

const resolverInputSchema = z
  .object({
    intent: intentSchema,
    assessment: assessmentSchema,
    constraints: z.array(constraintSchema),
    prior: z
      .object({
        decisions: z.array(decisionSchema),
        findings: z.array(findingSchema),
        requirements: z.array(requirementSchema),
      })
      .strict(),
    preferences: z
      .object({ fast: z.boolean().optional(), thorough: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

const compareCodeUnits = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

const stableUnique = (values: string[]): string[] => [...new Set(values)].sort(compareCodeUnits);

const stableList = <T>(values: T[]): T[] =>
  [...values].sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));

const normalizedScope = (scope: Scope): Scope => ({
  description: scope.description,
  paths: stableUnique(scope.paths),
  exclusions: stableUnique(scope.exclusions),
});

const normalizedRefList = <T>(values: T[]): T[] => stableList(values);

const normalizeAssessment = (assessment: Assessment): Assessment => ({
  facts: stableList(
    assessment.facts.map((fact) => ({ ...fact, refs: normalizedRefList(fact.refs) })),
  ),
  signals: Object.fromEntries(
    Object.entries(assessment.signals).map(([name, signal]) => [
      name,
      { ...signal, refs: normalizedRefList(signal.refs) },
    ]),
  ) as Assessment["signals"],
  consequences: stableList(
    assessment.consequences.map((consequence) => ({
      ...consequence,
      fact: { ...consequence.fact, refs: normalizedRefList(consequence.fact.refs) },
    })),
  ),
  verification: stableList(
    assessment.verification.map((verification) => ({
      ...verification,
      scope: normalizedScope(verification.scope),
      availableChecks: normalizedRefList(verification.availableChecks),
      gaps: stableUnique(verification.gaps),
    })),
  ),
});

const normalizeConstraint = (constraint: Constraint): Constraint => ({
  ...constraint,
  source: constraint.source,
  requires: stableList(
    constraint.requires.map((requirement) => ({
      ...requirement,
      scope: normalizedScope(requirement.scope),
      refs: normalizedRefList(requirement.refs),
    })),
  ),
});

const normalizeDecision = (decision: Decision): Decision => ({
  ...decision,
  binding: {
    ...decision.binding,
    scope: normalizedScope(decision.binding.scope),
    contentRefs: normalizedRefList(decision.binding.contentRefs),
  },
  requirementIds: stableUnique(decision.requirementIds),
});

const normalizeIntent = (intent: Intent): Intent => ({
  ...intent,
  scope: normalizedScope(intent.scope),
  authorityRefs: normalizedRefList(intent.authorityRefs),
});

const normalizePrior = (prior: ResolverPrior): ResolverPrior => ({
  decisions: stableList(prior.decisions.map(normalizeDecision)),
  findings: stableList(
    prior.findings.map((finding) => ({
      ...finding,
      scope: normalizedScope(finding.scope),
      refs: normalizedRefList(finding.refs),
      resolution: finding.resolution
        ? {
            ...finding.resolution,
            evidenceIds: stableUnique(finding.resolution.evidenceIds),
            decisionIds: stableUnique(finding.resolution.decisionIds),
          }
        : null,
    })),
  ),
  requirements: stableList(
    prior.requirements.map((requirement) => ({
      ...requirement,
      scope: normalizedScope(requirement.scope),
    })),
  ),
});

const invalidFields = (error: z.ZodError) => ({
  fields: error.issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
    reason: issue.message,
  })),
});

function normalizeResolverInput(input: unknown): Result<NormalizedResolverInput> {
  const parsed = resolverInputSchema.safeParse(input);
  if (!parsed.success)
    return failure("invalid_input", "resolver input is invalid", invalidFields(parsed.error));

  const value = parsed.data;
  const signals = value.assessment.signals;
  if (signals.behaviorChange.value === true && signals.mechanicalLowRisk.value === true)
    return failure("invalid_input", "behavioral change cannot be wholly mechanical", {
      fields: [
        {
          path: "assessment.signals",
          reason: "contradictory behaviorChange and mechanicalLowRisk",
        },
      ],
    });
  const ids = value.constraints.map((constraint) => constraint.id);
  if (new Set(ids).size !== ids.length)
    return failure("invalid_input", "constraint IDs must be unique", {
      fields: [{ path: "constraints", reason: "duplicate constraint id" }],
    });
  if (value.preferences?.fast && value.preferences.thorough)
    return failure("invalid_input", "fast and thorough preferences contradict", {
      fields: [{ path: "preferences", reason: "fast and thorough cannot both be enabled" }],
    });

  const normalized: NormalizedResolverInput = {
    intent: normalizeIntent(value.intent),
    assessment: normalizeAssessment(value.assessment),
    constraints: stableList(value.constraints.map(normalizeConstraint)),
    prior: normalizePrior(value.prior),
    ...(value.preferences ? { preferences: { ...value.preferences } } : {}),
    policyVersion: POLICY_VERSION,
  };
  return success(null, null, normalized);
}

type RequirementSpec = {
  ruleId: string;
  dimension: Dimension;
  scope: Scope;
  reason: string;
  satisfaction: string;
  before: Requirement["before"];
  dependentAction: string | null;
  acceptanceAllowed: boolean;
};

const requirement = (spec: RequirementSpec): Requirement => ({
  ...spec,
  id: requirementId({
    ruleId: spec.ruleId,
    scope: spec.scope,
    satisfaction: spec.satisfaction,
    before: spec.before,
    dependentAction: spec.dependentAction,
  }),
});

const signalReason = (input: NormalizedResolverInput, name: keyof Assessment["signals"]): string =>
  input.assessment.signals[name].reason;

function resolveRequirements(input: NormalizedResolverInput): Requirement[] {
  const { signals } = input.assessment;
  const scope = input.intent.scope;
  const requirements: Requirement[] = [];
  const hasUnknownSignal = Object.values(signals).some((signal) => signal.value === "unknown");
  const hasUnknownFact = [
    ...input.assessment.facts,
    ...input.assessment.consequences.map(({ fact }) => fact),
  ].some((fact) => fact.basis === "unknown");

  if (hasUnknownSignal || hasUnknownFact)
    requirements.push(
      requirement({
        ruleId: "consequential-unknown",
        dimension: "investigation",
        scope,
        reason: `Resolve consequential uncertainty before the dependent action: ${[
          ...Object.entries(signals)
            .filter(([, signal]) => signal.value === "unknown")
            .map(([name]) => name),
          ...(hasUnknownFact ? ["unknown fact"] : []),
        ].join(", ")}`,
        satisfaction:
          "An observed or inferred fact resolves the uncertainty and records its supporting references.",
        before: "dependent_action",
        dependentAction: "dependent-action",
        acceptanceAllowed: false,
      }),
    );

  if (signals.productChoiceOpen.value === true)
    requirements.push(
      requirement({
        ruleId: "product-decision",
        dimension: "decisions",
        scope,
        reason: `A consequential product choice remains open: ${signalReason(input, "productChoiceOpen")}`,
        satisfaction:
          "Present the material alternatives and record the user's decision before the dependent action.",
        before: "dependent_action",
        dependentAction: "dependent-action",
        acceptanceAllowed: false,
      }),
    );

  if (signals.behaviorChange.value === true)
    requirements.push(
      requirement({
        ruleId: "behavioral-verification",
        dimension: "testing",
        scope,
        reason: `Behavior, side effects, permissions, or data handling may change: ${signalReason(input, "behaviorChange")}`,
        satisfaction:
          "A useful behavioral check passes against the affected behavior and current candidate.",
        before: "close",
        dependentAction: null,
        acceptanceAllowed: false,
      }),
      requirement({
        ruleId: "fresh-context-review",
        dimension: "review",
        scope,
        reason: "A non-mechanical behavior change requires fresh-context review.",
        satisfaction:
          "A separate review context examines the current candidate and records its result.",
        before: "close",
        dependentAction: null,
        acceptanceAllowed: false,
      }),
    );
  else if (signals.mechanicalLowRisk.value === true)
    requirements.push(
      requirement({
        ruleId: "mechanical-existing-checks",
        dimension: "verification",
        scope,
        reason: `The change is demonstrably mechanical and low-risk: ${signalReason(input, "mechanicalLowRisk")}`,
        satisfaction:
          "Run the relevant existing checks for affected consumers; do not add tautological tests.",
        before: "close",
        dependentAction: null,
        acceptanceAllowed: true,
      }),
      requirement({
        ruleId: input.preferences?.thorough ? "fresh-context-review" : "self-review",
        dimension: "review",
        scope,
        reason: input.preferences?.thorough
          ? "The thorough preference upgrades mechanical self-review to fresh-context review."
          : "Mechanical low-risk work uses self-review rather than mandatory fresh-context review.",
        satisfaction: input.preferences?.thorough
          ? "A separate review context examines the current candidate and records its result."
          : "The lead reviews the resulting diff and records the relevant scope and checks.",
        before: "close",
        dependentAction: null,
        acceptanceAllowed: !input.preferences?.thorough,
      }),
    );

  if (signals.behaviorChange.value === true || signals.mechanicalLowRisk.value === true)
    requirements.push(
      requirement({
        ruleId: "pre-pr-cleanup",
        dimension: "verification",
        scope,
        reason: "Implementation output must be deslopped before it is delivered.",
        satisfaction:
          "Run the workit-deslop pass and record passing check evidence, or record an approved limitation decision waiving cleanup.",
        before: "dependent_action",
        dependentAction: "hosting.pull_request",
        acceptanceAllowed: true,
      }),
    );

  if (signals.durableAgreementNeeded.value === true)
    requirements.push(
      requirement({
        ruleId: "durable-spec",
        dimension: "artifacts",
        scope,
        reason: `The work needs a durable agreement about intended behavior: ${signalReason(input, "durableAgreementNeeded")}`,
        satisfaction:
          "Record the agreed behavior in a durable specification before implementation writes.",
        before: "write",
        dependentAction: null,
        acceptanceAllowed: true,
      }),
    );
  if (signals.coordinationPlanNeeded.value === true)
    requirements.push(
      requirement({
        ruleId: "coordination-plan",
        dimension: "continuity",
        scope,
        reason: `Dependencies, sequencing, or resumption need durable coordination: ${signalReason(input, "coordinationPlanNeeded")}`,
        satisfaction:
          "Record useful sequencing, dependencies, and the next action in a compact plan.",
        before: "dependent_action",
        dependentAction: null,
        acceptanceAllowed: true,
      }),
    );
  if (signals.helperUseful.value === true && !input.preferences?.fast)
    requirements.push(
      requirement({
        ruleId: "helper-usefulness",
        dimension: "delegation",
        scope,
        reason: `Independent judgment or investigation justifies a scoped helper: ${signalReason(input, "helperUseful")}`,
        satisfaction:
          "Use a bounded helper only for the independent objective and reconcile its result.",
        before: "dependent_action",
        dependentAction: null,
        acceptanceAllowed: true,
      }),
    );

  for (const constraint of input.constraints)
    for (const obligation of constraint.requires) {
      const dimension =
        obligation.method ??
        (obligation.kind === "check"
          ? "verification"
          : obligation.kind === "decision"
            ? "decisions"
            : "challenge");
      requirements.push(
        requirement({
          ruleId: `project-constraint:${constraint.id}:${obligation.kind}:${sha256({
            kind: obligation.kind,
            scope: normalizedScope(obligation.scope),
            refs: normalizedRefList(obligation.refs),
            method: obligation.method,
            before: obligation.before,
            dependentAction: obligation.dependentAction,
          })}`,
          dimension,
          scope: obligation.scope,
          reason: `${constraint.kind} constraint requires ${obligation.kind}: ${constraint.statement}`,
          satisfaction: `Satisfy the constraint obligation using its referenced ${obligation.kind}.`,
          before: obligation.before,
          dependentAction: obligation.dependentAction,
          acceptanceAllowed: constraint.acceptanceAllowed && obligation.kind !== "decision",
        }),
      );
    }

  const seen = new Set<string>();
  return requirements.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function resolvePolicy(input: ResolverInput): Result<Policy> {
  const normalized = normalizeResolverInput(input);
  if (!normalized.ok) return normalized;
  const requirements = resolveRequirements(normalized.data);
  const policy: Policy = {
    policyVersion: POLICY_VERSION,
    inputDigest: sha256(canonicalJson(normalized.data)),
    requirements,
  };
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success)
    return failure("invalid_input", "resolved policy is invalid", invalidFields(parsed.error));
  return success(null, null, parsed.data);
}

export function diffPolicy(
  previous: Policy | null,
  next: Policy,
  reason: string,
  now: string,
): PolicyChange | null {
  if (!policySchema.safeParse(previous).success && previous !== null)
    throw new TypeError("previous policy is invalid");
  if (!policySchema.safeParse(next).success) throw new TypeError("next policy is invalid");
  const oldIds = new Set(previous?.requirements.map((requirement) => requirement.id) ?? []);
  const newIds = new Set(next.requirements.map((requirement) => requirement.id));
  const added = [...newIds].filter((id) => !oldIds.has(id)).sort(compareCodeUnits);
  const retired = [...oldIds].filter((id) => !newIds.has(id)).sort(compareCodeUnits);
  if (added.length === 0 && retired.length === 0) return null;
  const normalizedReason = reason.trim();
  const changeReason = retired.length
    ? `${normalizedReason || "policy reassessed"} (retired: ${retired.join(",")})`
    : normalizedReason || "policy reassessed";
  const change = {
    recordedAt: now,
    fromInputDigest: previous?.inputDigest ?? null,
    toInputDigest: next.inputDigest,
    added,
    retired,
    reason: changeReason,
  } satisfies PolicyChange;
  const parsed = policyChangeSchema.safeParse(change);
  if (!parsed.success) throw new TypeError("policy change is invalid");
  return parsed.data;
}
