import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  Capability,
  Policy,
  Requirement,
  TaskView,
} from "@/packages/workit-core/src/core/task-contract";
import { invariantBootstrap, selectMethods } from "@/packages/workit-core/src/core/methods";
import { compactTaskContext } from "@/packages/workit-core/src/core/task-context";
import {
  WORKIT_METHOD_SKILLS,
  skillManifestNames,
} from "@/packages/workit-core/src/core/skill-manifests";

const skillText = (name: string) =>
  readFileSync(
    path.join(import.meta.dir, "../../packages/workit-core/skills", name, "SKILL.md"),
    "utf8",
  );

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

test("a fresh-context-review capability activates the review method", () => {
  const result = selectMethods(
    policy(requirement({ ruleId: "fresh-context-review", dimension: "review" })),
    [capability({ name: "fresh-context-review", surface: "task", assurance: "agent_guided" })],
  );
  expect(result).toMatchObject([{ id: "workit-review", assurance: "agent_guided" }]);
  const withoutCapability = selectMethods(
    policy(requirement({ ruleId: "fresh-context-review", dimension: "review" })),
    [],
  );
  expect(withoutCapability).toMatchObject([{ id: "workit-review", assurance: "unavailable" }]);
});

test("mechanical work routes checks to TDD and self-review to review", () => {
  const result = selectMethods(
    policy(
      requirement({ ruleId: "mechanical-existing-checks", dimension: "verification" }),
      requirement({ ruleId: "self-review", dimension: "review" }),
    ),
    [capability({ name: "review", surface: "review", assurance: "enforced" })],
  );
  expect(result.map((method) => method.id)).toEqual(["workit-behavioral-tdd", "workit-review"]);
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

test("pre-pr-cleanup selects the deslop method", () => {
  const result = selectMethods(
    policy(requirement({ ruleId: "pre-pr-cleanup", dimension: "verification" })),
    [],
  );
  expect(result.map((method) => method.id)).toEqual(["workit-deslop"]);
});

test("selection has stable registry order and no duplicate methods", () => {
  const selected = selectMethods(
    policy(
      requirement({ ruleId: "self-review", dimension: "review" }),
      requirement({ ruleId: "mechanical-existing-checks", dimension: "verification" }),
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
  ]);
  expect(new Set(selected.map((method) => method.id)).size).toBe(selected.length);
});

// Bootstrap and skill text is agent-facing prose: assert only the contract
// keywords an agent relies on, not whole sentences.
test("bootstrap defers to native host authority and mandates no Workit preamble", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap).toMatch(/allow\/ask\/deny/);
  expect(bootstrap).toMatch(/evade a denial/);
  expect(bootstrap).not.toContain("task.start then policy.assess");
  // Policy selects TDD and review; the bootstrap must not hard-wire them.
  expect(bootstrap).not.toContain("workit-behavioral-tdd");
  expect(bootstrap).not.toContain("workit-review");
});

test("bootstrap routes moment-based skill loads by name", () => {
  const bootstrap = invariantBootstrap();
  for (const skill of [
    "workit-steer",
    "workit-deslop",
    "workit-green-run",
    "workit-blast-radius",
    "workit-challenge",
    "workit-plan",
  ])
    expect(bootstrap).toContain(skill);
  expect(bootstrap).not.toContain("## Method");
});

test("bootstrap names every shared operation family", () => {
  const bootstrap = invariantBootstrap();
  for (const operation of [
    "task",
    "policy",
    "evidence",
    "finding",
    "decision",
    "worker",
    "writer",
    "state",
  ])
    expect(bootstrap).toContain(operation);
});

test("steer, babysit and challenge keep lifecycle and merge authority outside the skill", () => {
  const steer = skillText("workit-steer");
  expect(steer).not.toContain("task.start");
  expect(steer).not.toContain("policy.assess");
  expect(skillText("workit-babysit")).toMatch(/does not authorize merge/);
  expect(skillText("workit-challenge")).toMatch(/never fabricate a native permission/);
});

test("compact task context carries selected methods and refreshes with policy", () => {
  const view = (policyValue: Policy | null) =>
    ({
      task: {
        status: "active",
        intent: { data: { objective: "ship the release" } },
        decisions: [],
        progress: { nextAction: "run checks", blockers: [] },
        policy: policyValue,
      },
      capabilities: [],
      evidence: [],
      requirements: [],
    }) as unknown as TaskView;
  const unassessed = JSON.parse(compactTaskContext(view(null))) as { methods: unknown };
  expect(unassessed.methods).toEqual([]);
  const assessed = JSON.parse(
    compactTaskContext(
      view(policy(requirement({ ruleId: "product-decision", dimension: "decisions" }))),
    ),
  ) as { methods: unknown };
  expect(assessed.methods).toEqual([
    { id: "workit-challenge", assurance: "agent_guided", reason: "fixture requirement" },
  ]);
});

// One meaning-bearing phrase per agent-critical rule. Whitespace is flexible
// (the prose wraps), the words are not: inverting a rule fails here.
const phrase = (text: string) => new RegExp(text.trim().split(/\s+/).join("\\s+"));

test("agent-critical delivery rules stay stated", () => {
  const bootstrap = invariantBootstrap();
  const rules: Array<[string, string, string]> = [
    ["bootstrap", bootstrap, "prefer native host Git/shell"],
    ["bootstrap", bootstrap, "A local-commit endpoint does not imply PR readiness"],
    ["bootstrap", bootstrap, "reconcile every requested item"],
    ["bootstrap", bootstrap, "a local commit alone is not evidence of a requested remote push"],
    ["workit-babysit", skillText("workit-babysit"), "PR creation does not start babysitting"],
    ["workit-babysit", skillText("workit-babysit"), "Stop at PR-ready"],
    ["workit-steer", skillText("workit-steer"), "do not silently resume an old objective"],
    ["workit-plan", skillText("workit-plan"), "Do not ask for a separate plan approval"],
    ["workit-implement", skillText("workit-implement"), "reconcile every named deliverable"],
    [
      "workit-behavioral-tdd",
      skillText("workit-behavioral-tdd"),
      "GREEN but no preceding RED evidence stays unsatisfied",
    ],
  ];
  for (const [source, text, rule] of rules)
    expect(text, `${source}: ${rule}`).toMatch(phrase(rule));
});

test("method skills impose no task-start preamble and do not wait for policy selection", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const skill = skillText(name);
    expect(skill, name).not.toContain("Before method work");
    expect(skill, name).not.toContain("If there is no active or paused task");
    expect(skill, name).not.toMatch(/only when policy selects/i);
    expect(skill, name).not.toMatch(/when the `[^`]+` rule is selected/i);
  }
});

test("method manifest matches the canonical skill directories", () => {
  // Pinned on purpose: a skill-set change (adding or dropping a skill from
  // both the manifest and the directory) must update this count.
  expect(WORKIT_METHOD_SKILLS).toHaveLength(14);
  expect(
    skillManifestNames(path.join(import.meta.dir, "../../packages/workit-core/skills")),
  ).toEqual([...WORKIT_METHOD_SKILLS].sort());
});
