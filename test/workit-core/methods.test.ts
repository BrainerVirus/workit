import { expect, test } from "bun:test";
import type {
  Capability,
  Policy,
  Requirement,
} from "../../packages/workit-core/src/core/task-contract";
import { invariantBootstrap, selectMethods } from "../../packages/workit-core/src/core/methods";

const digest = "a".repeat(64);
const requirement = (overrides: Partial<Requirement>): Requirement => ({
  id: digest,
  ruleId: "fixture",
  dimension: "verification",
  scope: { description: "checkout", paths: ["."], exclusions: [] },
  reason: "fixture requirement",
  satisfaction: "fixture evidence",
  before: "close",
  dependentAction: null,
  acceptanceAllowed: true,
  ...overrides,
});

const policy = (...requirements: Requirement[]): Policy => ({
  policyVersion: "1.0.0",
  inputDigest: digest,
  requirements,
});

const capability = (overrides: Partial<Capability> = {}): Capability => ({
  name: "fixture",
  surface: "fixture",
  assurance: "agent_guided",
  reason: "fixture capability",
  refs: [],
  ...overrides,
});

test("mechanical work loads no design or TDD method", () => {
  const result = selectMethods(
    policy(
      requirement({ ruleId: "mechanical-existing-checks", dimension: "verification" }),
      requirement({ ruleId: "self-review", dimension: "review" }),
    ),
    [capability({ name: "review", surface: "review", assurance: "enforced" })],
  );
  expect(result.map((method) => method.id)).toEqual([]);
});

test("behavior change selects TDD and fresh review independently", () => {
  const result = selectMethods(
    policy(
      requirement({ ruleId: "behavioral-verification", dimension: "testing" }),
      requirement({ ruleId: "fresh-context-review", dimension: "review" }),
    ),
    [
      capability({ name: "testing", surface: "testing", assurance: "enforced" }),
      capability({ name: "review", surface: "review", assurance: "enforced" }),
    ],
  );
  expect(result.map((method) => method.id)).toEqual(["workit-behavioral-tdd", "workit-review"]);
});

test("challenge is selected without a plan", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "product-decision", dimension: "decisions" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-challenge"]);
});

test("continuity selects a plan without requiring a spec", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "coordination-plan", dimension: "continuity" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-plan"]);
});

test("helper usefulness selects implementation without formal documents", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "helper-usefulness", dimension: "delegation" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-implement"]);
});

test("unavailable independent review remains selected with unavailable assurance", () => {
  const [review] = selectMethods(
    policy(requirement({ ruleId: "fresh-context-review", dimension: "review" })),
    [
      capability({
        name: "review",
        surface: "review",
        assurance: "unavailable",
        reason: "no second context",
      }),
    ],
  );
  expect(review).toMatchObject({ id: "workit-review", assurance: "unavailable" });
  expect(review.reason).toContain("no second context");
});

test("missing independent review capability remains an unavailable gap", () => {
  const [review] = selectMethods(
    policy(requirement({ ruleId: "fresh-context-review", dimension: "review" })),
    [],
  );
  expect(review).toMatchObject({ id: "workit-review", assurance: "unavailable" });
});

test("selection has stable registry order and no duplicate methods", () => {
  const selected = selectMethods(
    policy(
      requirement({ ruleId: "durable-handoff", dimension: "continuity" }),
      requirement({ ruleId: "root-cause-investigation", dimension: "investigation" }),
      requirement({ ruleId: "behavioral-verification", dimension: "testing" }),
      requirement({ ruleId: "fresh-context-review", dimension: "review" }),
      requirement({ ruleId: "helper-usefulness", dimension: "delegation" }),
      requirement({ ruleId: "product-decision", dimension: "decisions" }),
      requirement({ ruleId: "coordination-plan", dimension: "continuity" }),
    ),
    [],
  );
  expect(selected.map((method) => method.id)).toEqual([
    "workit-challenge",
    "workit-behavioral-tdd",
    "workit-review",
    "workit-plan",
    "workit-implement",
    "workit-debug",
    "workit-handoff",
  ]);
  expect(new Set(selected.map((method) => method.id)).size).toBe(selected.length);
});

test("bootstrap contains invariant authority, state, and tool guidance only", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap.toLowerCase()).toContain("authority");
  expect(bootstrap.toLowerCase()).toContain("state");
  expect(bootstrap.toLowerCase()).toContain("operation");
  expect(bootstrap).not.toContain("workit-behavioral-tdd");
  expect(bootstrap).not.toContain("workit-review");
  expect(bootstrap).not.toContain("workit-plan");
});
