import { expect, test } from "bun:test";
import {
  diffPolicy,
  resolvePolicy,
  type ResolverInput,
} from "@/packages/workit-core/src/core/policy-resolver";
import type { Constraint } from "@/packages/workit-core/src/core/task-contract";
import { assessment, digest, id, ref, scope } from "./task-fixtures";

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
const rules = (result: ReturnType<typeof resolvePolicy>) =>
  data(result).requirements.map((r) => r.ruleId);

const constraint = (requires: Constraint["requires"]): Constraint => ({
  id: "repo-checks",
  kind: "project",
  statement: "project verification policy",
  source: ref(),
  acceptanceAllowed: false,
  requires,
});

const decision = (
  requirementIds: string[],
  contentRefs = [ref()],
): ResolverInput["prior"]["decisions"][number] => ({
  response: "approved",
  purpose: "limitation",
  binding: {
    taskId: id,
    workspaceId: id,
    scope: scope({ paths: ["src", "test"], exclusions: ["vendor"] }),
    presented: "accept this limitation",
    approvedContent: "accept this limitation",
    contentRefs,
  },
  digest,
  requirementIds,
  revoked: null,
  consumption: null,
});

test("mechanical work only requires relevant existing checks and self-review", () => {
  const result = resolvePolicy(input());
  expect(rules(result)).toEqual(["mechanical-existing-checks", "self-review", "pre-pr-cleanup"]);
  expect(rules(result)).not.toContain("durable-spec");
  expect(rules(result)).not.toContain("coordination-plan");
});

test("a broad behavior-preserving rename does not escalate by size", () => {
  const result = resolvePolicy(
    input({ intent: { ...input().intent, scope: scope({ paths: ["src", "test"] }) } }),
  );
  expect(rules(result)).toEqual(["mechanical-existing-checks", "self-review", "pre-pr-cleanup"]);
});

test("behavior changes require behavioral verification and fresh-context review", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          behaviorChange: {
            value: true,
            basis: "observed",
            reason: "authorization changes",
            refs: [ref()],
          },
          mechanicalLowRisk: {
            value: false,
            basis: "inferred",
            reason: "not mechanical",
            refs: [],
          },
        },
        consequences: [
          {
            area: "security",
            fact: { statement: "authorization", basis: "observed", refs: [ref()] },
          },
        ],
      }),
    }),
  );
  expect(rules(result)).toEqual([
    "behavioral-verification",
    "fresh-context-review",
    "pre-pr-cleanup",
  ]);
});

test("contradictory mechanical and behavioral signals fail reconciliation", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          behaviorChange: {
            value: true,
            basis: "observed",
            reason: "changes behavior",
            refs: [ref()],
          },
          mechanicalLowRisk: {
            value: true,
            basis: "observed",
            reason: "mechanical",
            refs: [ref()],
          },
        },
      }),
    }),
  );
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
});

test("independent signals produce independent artifact and coordination requirements", () => {
  const spec = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          durableAgreementNeeded: {
            value: true,
            basis: "observed",
            reason: "durable",
            refs: [ref()],
          },
        },
      }),
    }),
  );
  const plan = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          coordinationPlanNeeded: {
            value: true,
            basis: "observed",
            reason: "dependencies",
            refs: [ref()],
          },
        },
      }),
    }),
  );
  expect(rules(spec)).toContain("durable-spec");
  expect(rules(spec)).not.toContain("coordination-plan");
  expect(rules(plan)).toContain("coordination-plan");
  expect(rules(plan)).not.toContain("durable-spec");
});

test("helper usefulness is independent of formal documents", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          helperUseful: {
            value: true,
            basis: "observed",
            reason: "independent investigation",
            refs: [ref()],
          },
        },
      }),
    }),
  );
  expect(rules(result)).toEqual([
    "mechanical-existing-checks",
    "self-review",
    "pre-pr-cleanup",
    "helper-usefulness",
  ]);
});

test("consequential unknowns block only their dependent action", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          approachUnknown: {
            value: "unknown",
            basis: "unknown",
            reason: "dependency scope",
            refs: [],
          },
        },
      }),
    }),
  );
  const policy = data(result);
  expect(rules(result)).toContain("consequential-unknown");
  expect(
    policy.requirements.find((r) => r.ruleId === "consequential-unknown")?.dependentAction,
  ).toBe("dependent-action");
  expect(rules(result)).toContain("mechanical-existing-checks");
});

test("open product choices require a decision", () => {
  const result = resolvePolicy(
    input({
      assessment: assessment({
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          productChoiceOpen: {
            value: true,
            basis: "observed",
            reason: "two valid APIs",
            refs: [ref()],
          },
        },
      }),
    }),
  );
  expect(rules(result)).toContain("product-decision");
});

test("preferences adjust only the permitted helper/review process", () => {
  const helperInput = {
    assessment: assessment({
      ...input().assessment,
      signals: {
        ...input().assessment.signals,
        helperUseful: {
          value: true,
          basis: "inferred",
          reason: "independent investigation",
          refs: [],
        },
      },
    }),
  };
  expect(rules(resolvePolicy(input({ ...helperInput, preferences: { fast: true } })))).toEqual([
    "mechanical-existing-checks",
    "self-review",
    "pre-pr-cleanup",
  ]);
  expect(rules(resolvePolicy(input({ ...helperInput, preferences: { thorough: true } })))).toEqual([
    "mechanical-existing-checks",
    "fresh-context-review",
    "pre-pr-cleanup",
    "helper-usefulness",
  ]);

  const constrained = constraint([
    {
      kind: "method",
      scope: scope(),
      refs: [ref()],
      method: "delegation",
      before: "dependent_action",
      dependentAction: "delegate",
    },
  ]);
  const protectedInput = input({
    preferences: { fast: true },
    constraints: [constrained],
    assessment: assessment({
      ...input().assessment,
      signals: {
        ...input().assessment.signals,
        approachUnknown: { value: "unknown", basis: "unknown", reason: "scope", refs: [] },
        productChoiceOpen: {
          value: true,
          basis: "inferred",
          reason: "choice remains",
          refs: [],
        },
        behaviorChange: {
          value: true,
          basis: "inferred",
          reason: "behavior changes",
          refs: [],
        },
        mechanicalLowRisk: {
          value: false,
          basis: "inferred",
          reason: "not mechanical",
          refs: [],
        },
        durableAgreementNeeded: {
          value: true,
          basis: "inferred",
          reason: "durable behavior",
          refs: [],
        },
        coordinationPlanNeeded: {
          value: true,
          basis: "inferred",
          reason: "coordination",
          refs: [],
        },
        helperUseful: {
          value: true,
          basis: "inferred",
          reason: "helper",
          refs: [],
        },
      },
    }),
  });
  const protectedRules = rules(resolvePolicy(protectedInput));
  expect(protectedRules).toEqual(
    expect.arrayContaining([
      "consequential-unknown",
      "product-decision",
      "behavioral-verification",
      "fresh-context-review",
      "durable-spec",
      "coordination-plan",
    ]),
  );
  expect(
    protectedRules.some((rule) => rule.startsWith("project-constraint:repo-checks:method:")),
  ).toBe(true);
  expect(protectedRules).not.toContain("helper-usefulness");
});

test("contradictory preferences fail reconciliation", () => {
  expect(resolvePolicy(input({ preferences: { fast: true, thorough: true } }))).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
});

test("distinct same-kind constraints remain distinct while exact duplicates dedupe", () => {
  const first = {
    kind: "check" as const,
    scope: scope(),
    refs: [ref({ url: "https://example.test/one" })],
    method: null,
    before: "close" as const,
    dependentAction: null,
  };
  const second = {
    ...first,
    refs: [ref({ url: "https://example.test/two" })],
  };
  const result = data(resolvePolicy(input({ constraints: [constraint([first, second, first])] })));
  const obligations = result.requirements.filter((item) =>
    item.ruleId.startsWith("project-constraint:repo-checks:check:"),
  );
  expect(obligations).toHaveLength(2);
  expect(new Set(obligations.map((item) => item.id)).size).toBe(2);
});

test("constraint obligation kind and method combinations are validated", () => {
  const invalidMethod = {
    kind: "method" as const,
    scope: scope(),
    refs: [ref()],
    method: null,
    before: "write" as const,
    dependentAction: null,
  };
  const invalidCheck = {
    ...invalidMethod,
    kind: "check" as const,
    method: "verification" as const,
  };
  expect(resolvePolicy(input({ constraints: [constraint([invalidMethod])] }))).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
  expect(resolvePolicy(input({ constraints: [constraint([invalidCheck])] }))).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
});

test("observed facts and signals require supporting references", () => {
  expect(
    resolvePolicy(
      input({
        assessment: assessment({
          ...input().assessment,
          facts: [{ statement: "observed fact", basis: "observed", refs: [] }],
        }),
      }),
    ),
  ).toMatchObject({ ok: false, code: "invalid_input" });
  expect(
    resolvePolicy(
      input({
        assessment: assessment({
          ...input().assessment,
          signals: {
            ...input().assessment.signals,
            behaviorChange: {
              value: true,
              basis: "observed",
              reason: "observed behavior",
              refs: [],
            },
          },
        }),
      }),
    ),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("accepted tradeoffs remain settled without new evidence", () => {
  const first = data(
    resolvePolicy(
      input({
        assessment: assessment({
          ...input().assessment,
          signals: {
            ...input().assessment.signals,
            productChoiceOpen: {
              value: true,
              basis: "inferred",
              reason: "two valid APIs",
              refs: [],
            },
          },
        }),
      }),
    ),
  );
  const productRequirement = first.requirements.find((item) => item.ruleId === "product-decision");
  expect(productRequirement).toBeDefined();
  const second = data(
    resolvePolicy(
      input({
        assessment: assessment({
          ...input().assessment,
          signals: {
            ...input().assessment.signals,
            productChoiceOpen: {
              value: true,
              basis: "inferred",
              reason: "two valid APIs",
              refs: [],
            },
          },
        }),
        prior: {
          decisions: [decision([productRequirement!.id])],
          findings: [],
          requirements: first.requirements,
        },
      }),
    ),
  );
  expect(second.requirements).toEqual(first.requirements);
  expect(
    diffPolicy(first, second, "accepted limitation remains settled", "2026-09-04T00:00:00Z"),
  ).toBe(null);
});

test("equivalent reordered inputs replay to identical policy bytes", () => {
  const firstContent = ref({ url: "https://example.test/first" });
  const secondContent = ref({ url: "https://example.test/second" });
  const firstDecision = decision([digest, "b".repeat(64)], [firstContent, secondContent]);
  const reorderedDecision = decision(["b".repeat(64), digest], [secondContent, firstContent]);
  reorderedDecision.binding.scope.paths.reverse();
  reorderedDecision.binding.scope.exclusions.reverse();
  const a = data(
    resolvePolicy(
      input({
        prior: { decisions: [firstDecision], findings: [], requirements: [] },
      }),
    ),
  );
  const b = data(
    resolvePolicy(
      input({
        prior: { decisions: [reorderedDecision], findings: [], requirements: [] },
      }),
    ),
  );
  expect(b).toEqual(a);
});

test("malformed and unknown resolver input is rejected", () => {
  expect(
    resolvePolicy({ ...input(), surprise: true } as ResolverInput & { surprise: boolean }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
  expect(
    resolvePolicy({
      ...input(),
      assessment: {
        ...input().assessment,
        signals: {
          ...input().assessment.signals,
          behaviorChange: { value: "unknown", basis: "observed", reason: "bad", refs: [] },
        },
      },
    }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("diffPolicy reports explicit additions and removals", () => {
  const previous = data(resolvePolicy(input()));
  const next = data(
    resolvePolicy(
      input({
        assessment: assessment({
          ...input().assessment,
          signals: {
            ...input().assessment.signals,
            mechanicalLowRisk: {
              value: false,
              basis: "inferred",
              reason: "mechanical work removed",
              refs: [],
            },
            durableAgreementNeeded: {
              value: true,
              basis: "observed",
              reason: "now durable",
              refs: [ref()],
            },
          },
        }),
      }),
    ),
  );
  const change = diffPolicy(
    previous,
    next,
    "new durable agreement evidence",
    "2026-09-04T00:00:00Z",
  );
  expect(change?.recordedAt).toBe("2026-09-04T00:00:00Z");
  expect(typeof change?.reason).toBe("string");
  expect(String(change?.reason)).toContain("retired:");
  expect(String(change?.reason)).toContain("new durable agreement evidence");
  expect(change?.added.length).toBe(1);
  expect(change?.retired).toEqual(
    expect.arrayContaining(previous.requirements.map((requirement) => requirement.id)),
  );
  expect(() =>
    diffPolicy(previous, { ...next, inputDigest: "bad" } as typeof next, "invalid", "bad"),
  ).toThrow();
});
