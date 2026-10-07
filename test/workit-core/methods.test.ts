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
import { DEFAULT_ENDPOINT, DEFAULT_ENDPOINTS } from "@/packages/workit-core/src/autonomy";
import { babysitAction, type NextAction } from "@/packages/workit-core/src/forge/report";
import {
  WORKIT_METHOD_SKILLS,
  skillManifestNames,
} from "@/packages/workit-core/src/core/skill-manifests";

const skillText = (name: string) =>
  readFileSync(
    path.join(import.meta.dir, "../../packages/workit-core/skills", name, "SKILL.md"),
    "utf8",
  );

const fanoutOrchestration = () =>
  readFileSync(
    path.join(
      import.meta.dir,
      "../../packages/workit-core/skills/workit-fanout/references/orchestration.md",
    ),
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
    [
      capability({
        name: "fresh-context-review",
        surface: "task",
        assurance: "agent_guided",
      }),
    ],
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
      requirement({
        ruleId: "mechanical-existing-checks",
        dimension: "verification",
      }),
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
      capability({
        name: "testing",
        surface: "testing",
        assurance: "enforced",
      }),
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
  expect(review).toMatchObject({
    id: "workit-review",
    assurance: "unavailable",
  });
  expect(review.reason).toContain("no second context");
});

test("missing independent review capability remains an unavailable gap", () => {
  const [review] = selectMethods(
    policy(requirement({ ruleId: "fresh-context-review", dimension: "review" })),
    [],
  );
  expect(review).toMatchObject({
    id: "workit-review",
    assurance: "unavailable",
  });
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
      requirement({
        ruleId: "mechanical-existing-checks",
        dimension: "verification",
      }),
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
  expect(bootstrap).toMatch(/never fabricate an\s+approval or verdict/);
  expect(bootstrap).not.toContain("task.start then policy.assess");
  expect(bootstrap).not.toContain("## Method");
});

test("bootstrap names every shared operation family once, as optional continuity", () => {
  const bootstrap = invariantBootstrap();
  for (const operation of ["task", "policy", "evidence", "finding", "decision", "worker", "state"])
    expect(bootstrap).toContain(operation);
  expect(bootstrap).toMatch(/a solo edit needs no task\./);
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
  const unassessed = JSON.parse(compactTaskContext(view(null))) as {
    methods: unknown;
  };
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
    // S17 user decision: the author's own verdict is allowed only as --self.
    ["bootstrap", bootstrap, "shown as self-reviewed, never verified"],
    ["bootstrap", bootstrap, "resolve competing targets before a mutation"],
    ["bootstrap", bootstrap, "never claim enforcement a host cannot provide"],
    ["bootstrap", bootstrap, "A question answer is not host permission"],
    [
      "bootstrap",
      bootstrap,
      "No endpoint named: stop at a local commit on a policy-compliant branch",
    ],
    ["bootstrap", bootstrap, "go to the effective endpoint in `workit grant show`"],
    ["workit-ship", skillText("workit-ship"), "report that a rebase is needed and stop"],
    ["workit-fanout", skillText("workit-fanout"), "any file outside it stops the fan-in"],
    ["workit-fanout", skillText("workit-fanout"), "observe that it exited"],
    ["workit-fanout", skillText("workit-fanout"), "drops its uncommitted changes"],
    ["workit-fanout", skillText("workit-fanout"), "never chosen by the author"],
    ["bootstrap", bootstrap, "need a verifier with its own"],
    ["workit-verify-app", skillText("workit-verify-app"), "never overwrite it"],
    ["workit-ship", skillText("workit-ship"), "PR creation does not start babysitting"],
    ["workit-ship", skillText("workit-ship"), "Stop at PR-ready"],
    ["workit-ship", skillText("workit-ship"), 'stop at "verified, ready"'],
    ["workit-continue", skillText("workit-continue"), "do not silently resume an old objective"],
    ["workit-shape", skillText("workit-shape"), "Do not ask for a separate plan approval"],
    ["workit-shape", skillText("workit-shape"), "ask that one question, then stop and wait"],
    ["workit-shape", skillText("workit-shape"), "Propose a record (never create one silently)"],
    ["workit-implement", skillText("workit-implement"), "reconcile every named deliverable"],
    ["workit-implement", skillText("workit-implement"), "reads self-reviewed, never verified"],
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
    // Fanout v2: one retry, then escalate; a rolling window; batch verifiers;
    // the panel and the integration-tip merge only where they are allowed.
    ["workit-fanout", skillText("workit-fanout"), "gets one retry with a fresh brief"],
    [
      "workit-fanout",
      skillText("workit-fanout"),
      "if that fails too, re-slice it, take it over, or report the gap",
    ],
    ["workit-fanout", skillText("workit-fanout"), "keep 4-6 in flight and refill from `spawnable`"],
    ["workit-fanout", skillText("workit-fanout"), "Never hand-edit it"],
    ["workit-fanout", skillText("workit-fanout"), "Verify by the workspace `verification` setting"],
    [
      "workit-fanout",
      skillText("workit-fanout"),
      "never yours (doctrine: the ledger only refuses authors)",
    ],
    ["fanout orchestration", fanoutOrchestration(), "This is doctrine, not enforced"],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "the SubagentStart hook names each `verifier` and `reviewer` its own session",
    ],
    [
      "workit-fanout",
      skillText("workit-fanout"),
      "One verifier may take a batch of slices, one verdict per branch",
    ],
    [
      "workit-fanout",
      skillText("workit-fanout"),
      "A review panel on separate models only at high risk",
    ],
    [
      "workit-fanout",
      skillText("workit-fanout"),
      "except the integration-tip merge in integration mode",
    ],
    ["fanout orchestration", fanoutOrchestration(), "| mundane | `sonnet` |"],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "| scouting (read-only search, not a slice) | `haiku` |",
    ],
    ["fanout orchestration", fanoutOrchestration(), "| hard | omit it (inherits yours)"],
    ["fanout orchestration", fanoutOrchestration(), "escalate instead of a third worker"],
    ["fanout orchestration", fanoutOrchestration(), "keep the one with the best verdict"],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "Every verdict is keyed to that branch's head SHA",
    ],
    ["fanout orchestration", fanoutOrchestration(), "At risk=high only"],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "A lead that authored none of the slices may record them in its own session",
    ],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "`independent`, and any slice at high risk: a separate verifier session",
    ],
    [
      "fanout orchestration",
      fanoutOrchestration(),
      "That merge is the only one a worker makes, and only in this mode",
    ],
    ["fanout orchestration", fanoutOrchestration(), "Only when the user wants one PR"],
    ["workit-verify-app", skillText("workit-verify-app"), "Prove it end-to-end once"],
    ["workit-retro", skillText("workit-retro"), "never start it yourself"],
    ["workit-retro", skillText("workit-retro"), "2 or more cited occurrences"],
    ["workit-retro", skillText("workit-retro"), "only if the user opts in"],
    ["workit-retro", skillText("workit-retro"), "Nothing changes until the user approves"],
    ["workit-retro", skillText("workit-retro"), "Never fork a local copy"],
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
  expect(WORKIT_METHOD_SKILLS).toHaveLength(12);
  expect(
    skillManifestNames(path.join(import.meta.dir, "../../packages/workit-core/skills")),
  ).toEqual([...WORKIT_METHOD_SKILLS].toSorted());
});

// Babysit endpoints (defaultEndpoint green|merged): the doctrine an agent acts
// on after opening a PR. Each phrase is a rule; dropping or inverting one fails.
test("bootstrap routes every endpoint above commit and keeps green short of a merge", () => {
  const bootstrap = invariantBootstrap();
  for (const endpoint of DEFAULT_ENDPOINTS.filter((value) => value !== DEFAULT_ENDPOINT))
    expect(bootstrap, endpoint).toContain(`\`${endpoint}\``);
  for (const rule of [
    "`green` babysits it without asking (workit-ship) to merge-ready",
    "never merging; `merged` also lands it with `workit pr merge`",
  ])
    expect(bootstrap, rule).toMatch(phrase(rule));
});

test("workit-ship states the babysit loop, its verbs and its only stop conditions", () => {
  const ship = skillText("workit-ship");
  for (const rule of [
    "that endpoint applies only when the request named none",
    "Stop at PR-ready (`babysit` `ready`)",
    "After opening the PR keep babysitting without asking until CI is green, every thread is resolved and the verification gate is met; `green` never merges",
    "`merged` without the merge grant acts as `green`); a lowered one's reason names the unblock",
    "`wait`: `workit ci wait` in the background where the host allows",
    "re-check `workit pr status` in the background with backoff, at most 5 times, then stop and report",
    "`update-branch` (conflicts or a required rebase): step 3",
    "`mark-ready`: mark the draft ready",
    "`ready`: under `green`, stop; under `merged`, run step 6 once the verdict is accepted",
    "`null` (closed, not merged): stop and report",
    "one `workit ci rerun --failed --reason flake|infra` per head",
    "Stop early only for a new consequential choice, a host denial, a review comment that needs a product decision, a required update that repeats because the base keeps moving, or after 3 failed fix attempts on the same check",
  ])
    expect(ship, rule).toMatch(phrase(rule));
  expect(skillText("workit-implement")).toMatch(
    phrase("effective endpoint in `workit grant show` is `pr`, `green` or `merged`"),
  );
});

test("workit-ship names every babysit step `workit pr status` can report", () => {
  const ship = skillText("workit-ship");
  const nexts: NextAction[] = [
    "MERGED",
    "CLOSED",
    "RESOLVE_CONFLICTS",
    "REBASE",
    "RESOLVE_THREADS",
    "FIX_CI",
    "WAITING_CI",
    "ADDRESS_REVIEW",
    "REVIEW",
    "MARK_READY",
    "IN_MERGE_QUEUE",
    "NOT_MERGEABLE",
    "READY",
  ];
  const steps = new Set(
    nexts.flatMap((next) =>
      [true, false].map((draft) => babysitAction(next, "mergeability_unknown", draft)),
    ),
  );
  steps.delete(null);
  expect(steps.size).toBe(8);
  for (const step of steps) expect(ship, String(step)).toContain(`\`${step}\``);
});
