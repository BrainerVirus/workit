import { expect, test } from "bun:test";
import {
  diffPolicy,
  resolvePolicy,
  type ResolverInput,
} from "../../packages/workit-core/src/core/policy-resolver";
import { assessment, scope } from "./task-fixtures";

const input = (overrides: Partial<ResolverInput> = {}): ResolverInput => ({
  intent: {
    objective: "change the checkout",
    scope: scope(),
    authorityRefs: [],
  },
  assessment: assessment({
    signals: {
      ...assessment().signals,
      approachUnknown: { value: false, basis: "inferred", reason: "inspected", refs: [] },
      productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
      behaviorChange: { value: false, basis: "inferred", reason: "mechanical", refs: [] },
      mechanicalLowRisk: { value: true, basis: "inferred", reason: "mechanical", refs: [] },
      durableAgreementNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
      coordinationPlanNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
      helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
      testFirstPractical: { value: true, basis: "inferred", reason: "yes", refs: [] },
    },
  }),
  constraints: [],
  prior: { decisions: [], findings: [], requirements: [] },
  ...overrides,
});

const data = (result: ReturnType<typeof resolvePolicy>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const rules = (result: ReturnType<typeof resolvePolicy>) => data(result).requirements.map((r) => r.ruleId);

test("mechanical work only requires relevant existing checks and self-review", () => {
  const result = resolvePolicy(input());
  expect(rules(result)).toEqual(["mechanical-existing-checks", "self-review"]);
  expect(rules(result)).not.toContain("durable-spec");
  expect(rules(result)).not.toContain("coordination-plan");
});

test("a broad behavior-preserving rename does not escalate by size", () => {
  const result = resolvePolicy(input({ intent: { ...input().intent, scope: scope({ paths: ["src", "test"] }) } }));
  expect(rules(result)).toEqual(["mechanical-existing-checks", "self-review"]);
});

test("behavior changes require behavioral verification and fresh-context review", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          behaviorChange: { value: true, basis: "observed", reason: "authorization changes", refs: [] },
          mechanicalLowRisk: { value: false, basis: "inferred", reason: "not mechanical", refs: [] },
        },
        consequences: [{ area: "security", fact: { statement: "authorization", basis: "observed", refs: [] } }],
      }),
    }),
  );
  expect(rules(result)).toEqual(["behavioral-verification", "fresh-context-review"]);
});

test("contradictory mechanical and behavioral signals fail reconciliation", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          behaviorChange: { value: true, basis: "observed", reason: "changes behavior", refs: [] },
          mechanicalLowRisk: { value: true, basis: "observed", reason: "mechanical", refs: [] },
        },
      }),
    }),
  );
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
});

test("independent signals produce independent artifact and coordination requirements", () => {
  const spec = resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, durableAgreementNeeded: { value: true, basis: "observed", reason: "durable", refs: [] } } }) }));
  const plan = resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, coordinationPlanNeeded: { value: true, basis: "observed", reason: "dependencies", refs: [] } } }) }));
  expect(rules(spec)).toContain("durable-spec");
  expect(rules(spec)).not.toContain("coordination-plan");
  expect(rules(plan)).toContain("coordination-plan");
  expect(rules(plan)).not.toContain("durable-spec");
});

test("helper usefulness is independent of formal documents", () => {
  const result = resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, helperUseful: { value: true, basis: "observed", reason: "independent investigation", refs: [] } } }) }));
  expect(rules(result)).toEqual(["mechanical-existing-checks", "self-review", "helper-usefulness"]);
});

test("consequential unknowns block only their dependent action", () => {
  const result = resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, approachUnknown: { value: "unknown", basis: "unknown", reason: "dependency scope", refs: [] } } }) }));
  const policy = data(result);
  expect(rules(result)).toContain("consequential-unknown");
  expect(policy.requirements.find((r) => r.ruleId === "consequential-unknown")?.dependentAction).toBe("dependent-action");
  expect(rules(result)).toContain("mechanical-existing-checks");
});

test("open product choices require a decision", () => {
  const result = resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, productChoiceOpen: { value: true, basis: "observed", reason: "two valid APIs", refs: [] } } }) }));
  expect(rules(result)).toContain("product-decision");
});

test("accepted tradeoffs remain settled without new evidence", () => {
  const first = data(resolvePolicy(input({ prior: { decisions: [{ response: "approved", purpose: "limitation", binding: { taskId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000001", scope: scope(), presented: "skip review", approvedContent: "skip review", contentRefs: [] }, digest: "a".repeat(64), requirementIds: [], revoked: null, consumption: null }], findings: [], requirements: [] } })));
  const second = data(resolvePolicy(input({ prior: { decisions: [], findings: [], requirements: first.requirements } })));
  expect(second.requirements).toEqual(first.requirements);
});

test("equivalent reordered inputs replay to identical policy bytes", () => {
  const a = data(resolvePolicy(input()));
  const b = data(resolvePolicy({ ...input(), constraints: [], prior: { requirements: [], findings: [], decisions: [] } }));
  expect(b).toEqual(a);
});

test("malformed and unknown resolver input is rejected", () => {
  expect(resolvePolicy({ ...input(), surprise: true } as ResolverInput & { surprise: boolean })).toMatchObject({ ok: false, code: "invalid_input" });
  expect(resolvePolicy({ ...input(), assessment: { ...input().assessment, signals: { ...input().assessment.signals, behaviorChange: { value: "unknown", basis: "observed", reason: "bad", refs: [] } } } })).toMatchObject({ ok: false, code: "invalid_input" });
});

test("diffPolicy reports explicit additions and removals", () => {
  const previous = data(resolvePolicy(input()));
  const next = data(resolvePolicy(input({ assessment: assessment({ ...input().assessment, signals: { ...input().assessment.signals, durableAgreementNeeded: { value: true, basis: "observed", reason: "now durable", refs: [] } } }) })));
  const change = diffPolicy(previous, next, "new durable agreement evidence", "2026-09-04T00:00:00Z");
  expect(change).toMatchObject({ recordedAt: "2026-09-04T00:00:00Z", reason: "new durable agreement evidence" });
  expect(change?.added.length).toBe(1);
});
