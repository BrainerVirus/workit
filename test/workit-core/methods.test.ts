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

test("bootstrap preserves host authority and keeps Workit coordination optional", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap.toLowerCase()).toContain("authority");
  expect(bootstrap.toLowerCase()).toContain("state");
  expect(bootstrap.toLowerCase()).toContain("operation");
  expect(bootstrap).toContain("Native host allow/ask/deny");
  expect(bootstrap).toContain("zero Workit task, assessment, or writer calls");
  expect(bootstrap).toContain("prefer native host Git/shell");
  expect(bootstrap).toContain("Never switch execution paths to evade a denial");
  expect(bootstrap).toContain("A local-commit endpoint does not imply");
  expect(bootstrap.toLowerCase()).toContain("not automatic");
  expect(bootstrap).not.toContain("run task.start then policy.assess");
  expect(bootstrap).not.toContain("workit-behavioral-tdd");
  expect(bootstrap).not.toContain("workit-review");
  expect(bootstrap).toContain(
    "Load workit-plan when dependencies or handoff need durable next actions",
  );
});

test("bootstrap routes moment-based skill loads by name", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap).toContain("Skill routing");
  expect(bootstrap).toContain("workit-steer");
  expect(bootstrap).toContain("workit-deslop");
  expect(bootstrap).toContain("workit-green-run");
  expect(bootstrap).toContain("workit-blast-radius");
  expect(bootstrap).toContain("workit-challenge");
  expect(bootstrap).not.toContain("## Method");
});

test("bootstrap records only work that benefits from continuity or coordination", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap).toContain("handoff, dependent steps, concurrent actors");
  expect(bootstrap).toContain("A solo edit does not need writer acquisition");
  expect(bootstrap).toContain("Answer a quick question without pausing/resuming task state");
  expect(bootstrap).toContain("not a permission system or a mandatory workflow");
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

test("steer stays lifecycle-free and babysit preserves explicit merge evidence", () => {
  const steer = skillText("workit-steer");
  expect(steer).toContain("Answer a quick question");
  expect(steer).toContain("do not silently resume an old objective");
  expect(steer).not.toContain("task.start");
  expect(steer).not.toContain("policy.assess");
  const babysit = skillText("workit-babysit");
  expect(babysit).toContain("PR creation does not start babysitting");
  expect(babysit).toContain("Stop at PR-ready");
  expect(babysit).toContain("does not authorize merge");
  expect(babysit).not.toContain("drive + merge");
  expect(babysit).toContain("squash merge");
  expect(babysit).toContain("re-record");
  expect(babysit).toContain("route Workit did not enforce");
});

test("challenge presents evidence-led options without a receipt or debate ritual", () => {
  const skill = skillText("workit-challenge");
  expect(skill).toContain("two or three genuinely different");
  expect(skill).toContain("small round");
  expect(skill).toContain("never fabricate a native permission");
  expect(skill).toContain("Brainstorming alone does not require a spec");
  expect(skill).not.toContain("receipt-shaped question");
  expect(skill).not.toContain("three rounds");
});

test("planning keeps documentation proportional and continues through the authorized endpoint", () => {
  const plan = skillText("workit-plan");
  expect(plan).toContain("A small fix needs no document");
  expect(plan).toContain(
    "Create a spec when a durable behavior contract or interface is requested",
  );
  expect(plan).toContain("proceed through the agreed endpoint");
  expect(plan).toContain("Do not ask for a separate plan approval");
  expect(skillText("workit-implement")).toContain("checks appropriate to the requested");
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

test("method skills do not impose a universal task-start or assessment preamble", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const skill = skillText(name);
    expect(skill, name).not.toContain("Before method work");
    expect(skill, name).not.toContain("If there is no active or paused task");
  }
  expect(skillText("workit-plan")).toContain("never a prerequisite for implementation");
});

test("debug and behavioral-tdd do not wait for pre-assess policy selection", () => {
  for (const name of ["workit-debug", "workit-behavioral-tdd"] as const) {
    const skill = skillText(name);
    expect(skill, name).not.toMatch(/only when policy selects/i);
    expect(skill, name).not.toMatch(/when the `[^`]+` rule is selected/i);
  }
});

test("host skill copies stay byte-identical to every canonical core skill", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const canonical = skillText(name);
    for (const host of ["opencode/assets/skills", "cursor/skills", "codex/skills", "pi/skills"]) {
      const relative = `packages/workit-${host}/${name}/SKILL.md`;
      expect(readFileSync(path.join(import.meta.dir, "../..", relative), "utf8"), relative).toBe(
        canonical,
      );
    }
  }
});

test("method manifest lists exactly fourteen core skills", () => {
  expect(WORKIT_METHOD_SKILLS).toEqual([
    "workit-challenge",
    "workit-behavioral-tdd",
    "workit-review",
    "workit-plan",
    "workit-implement",
    "workit-debug",
    "workit-handoff",
    "workit-babysit",
    "workit-blast-radius",
    "workit-deslop",
    "workit-diagram",
    "workit-mockup",
    "workit-green-run",
    "workit-steer",
  ]);
  expect(skillManifestNames("packages/workit-core/skills")).toEqual([
    ...[...WORKIT_METHOD_SKILLS].sort(),
  ]);
});
