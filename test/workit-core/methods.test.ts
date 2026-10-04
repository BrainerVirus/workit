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

test("mechanical work routes existing checks to implement and self-review to review", () => {
  const result = selectMethods(
    policy(
      requirement({ ruleId: "mechanical-existing-checks", dimension: "verification" }),
      requirement({ ruleId: "self-review", dimension: "review" }),
    ),
    [capability({ name: "review", surface: "review", assurance: "enforced" })],
  );
  expect(result.map((method) => method.id)).toEqual(["workit-review", "workit-implement"]);
});

test("behavior change selects BDD and fresh review independently", () => {
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
  expect(result.map((method) => method.id)).toEqual(["workit-bdd", "workit-review"]);
});

test("an open product decision selects shape", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "product-decision", dimension: "decisions" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-shape"]);
});

test("continuity selects shape without requiring a spec", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "coordination-plan", dimension: "continuity" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-shape"]);
});

test("helper usefulness selects fanout without formal documents", () => {
  expect(
    selectMethods(
      policy(requirement({ ruleId: "helper-usefulness", dimension: "delegation" })),
      [],
    ).map((method) => method.id),
  ).toEqual(["workit-fanout"]);
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
    "workit-shape",
    "workit-bdd",
    "workit-review",
    "workit-implement",
    "workit-fanout",
  ]);
  expect(new Set(selected.map((method) => method.id)).size).toBe(selected.length);
});

// Bootstrap and skill text is agent-facing prose: assert only the contract
// keywords an agent relies on, not whole sentences.
test("bootstrap defers to native host authority and mandates no Workit preamble", () => {
  const bootstrap = invariantBootstrap();
  expect(bootstrap).toMatch(/allow\/ask\/deny/);
  expect(bootstrap).toMatch(/evade a denial/);
  expect(bootstrap).toMatch(/never fabricate a\s+receipt/);
  expect(bootstrap).not.toContain("task.start then policy.assess");
  expect(bootstrap).not.toContain("## Method");
});

test("bootstrap names every shared operation family once, as optional continuity", () => {
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
  expect(bootstrap).toMatch(/a solo edit needs no task or writer/);
});

test("continue and ship keep lifecycle and merge authority outside the skill", () => {
  const resume = skillText("workit-continue");
  expect(resume).not.toContain("task.start");
  expect(resume).not.toContain("policy.assess");
  expect(skillText("workit-ship")).toMatch(/does not authorize\s+merge/);
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
    { id: "workit-shape", assurance: "agent_guided", reason: "fixture requirement" },
  ]);
});

// One meaning-bearing phrase per agent-critical rule. Whitespace is flexible
// (the prose wraps), the words are not: inverting a rule fails here.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (text: string) =>
  new RegExp(text.trim().split(/\s+/).map(escapeRegExp).join("\\s+"));

test("agent-critical delivery rules stay stated", () => {
  const bootstrap = invariantBootstrap();
  const rules: Array<[string, string, string]> = [
    // CLI-first replaced "prefer native host Git/shell": one right answer, one verb.
    ["bootstrap", bootstrap, "if a step has one right answer, use the `workit` verb"],
    ["bootstrap", bootstrap, "A local-commit endpoint does not imply PR readiness"],
    ["bootstrap", bootstrap, "reconcile every requested item"],
    ["bootstrap", bootstrap, "a local commit alone is not evidence of a requested remote push"],
    ["bootstrap", bootstrap, "Continue to the requested endpoint"],
    [
      "bootstrap",
      bootstrap,
      "Ask only for a product or preference choice, or for authority you lack",
    ],
    ["bootstrap", bootstrap, "Label claims measured"],
    ["bootstrap", bootstrap, "never record a passing verdict on work your session wrote"],
    ["workit-ship", skillText("workit-ship"), "PR creation does not start babysitting"],
    ["workit-ship", skillText("workit-ship"), "Stop at PR-ready"],
    ["workit-ship", skillText("workit-ship"), 'stop at "verified, ready"'],
    ["workit-continue", skillText("workit-continue"), "do not silently resume an old objective"],
    ["workit-shape", skillText("workit-shape"), "Do not ask for a separate plan approval"],
    ["workit-shape", skillText("workit-shape"), "ask that one question, then stop and wait"],
    ["workit-shape", skillText("workit-shape"), "Propose a record (never create one silently)"],
    ["workit-implement", skillText("workit-implement"), "reconcile every named deliverable"],
    [
      "workit-implement",
      skillText("workit-implement"),
      "Never record a passing verdict on your own work",
    ],
    ["workit-review", skillText("workit-review"), "cannot record a passing verdict"],
    ["workit-debug", skillText("workit-debug"), "Build the loop before any hypothesis"],
    ["workit-bdd", skillText("workit-bdd"), "Write one vertical RED slice that fails"],
    ["workit-bdd", skillText("workit-bdd"), 'A recorded "tests pass" is a note'],
    [
      "workit-bdd",
      skillText("workit-bdd"),
      "ad-hoc `workit check -- <cmd>` never satisfies the gate",
    ],
    ["workit-fanout", skillText("workit-fanout"), "refuse to spawn while a field is empty"],
    ["workit-fanout", skillText("workit-fanout"), "Replace at most twice"],
    ["workit-verify-app", skillText("workit-verify-app"), "Prove it end-to-end once"],
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
  expect(WORKIT_METHOD_SKILLS).toHaveLength(11);
  expect(
    skillManifestNames(path.join(import.meta.dir, "../../packages/workit-core/skills")),
  ).toEqual([...WORKIT_METHOD_SKILLS].toSorted());
});
