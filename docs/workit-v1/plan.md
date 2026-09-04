# Workit v1 Adaptive Engineering Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Workit 0.x with a breaking Workit 1.0 release whose deterministic shared core adapts engineering discipline to the work and whose OpenCode, Cursor, Codex, Pi, and CLI integrations use the strongest truthful native controls available.

**Architecture:** Build the v1 core as small, independently testable modules beside the old flow, then connect one native surface at a time through the eight closed operation families. Keep runtime truth in project-local atomic JSON snapshots, keep model execution in the native hosts, and remove the 0.x workflow only after every v1 surface passes the shared contract. Compatibility work is limited to an explicit preview/apply/rollback cutover at the end.

**Tech Stack:** TypeScript 7.0.2, Node.js 24 LTS, Bun 1.4.1 and Bun test, Zod 4.5.4 compiled strict schemas, MCP SDK 1.30.0 for Cursor/Codex tools, OpenCode 1.18.27 native plugins, Codex CLI 0.153.2 plugins/hooks, and Pi 0.85.0 extensions and stock-Pi subprocesses.

**Spec:** [docs/workit-v1/spec.md](spec.md), with the normative wire contract in [docs/workit-v1/contracts.md](contracts.md).

## Global constraints

- Use `schemaVersion: 1` and initial `policyVersion: "1.0.0"` exactly. Change neither as incidental implementation cleanup.
- One shared core owns policy, lifecycle, requirement evaluation, revisions, authority, and writer ownership. Adapters only map native observations and presentation.
- Use one guarded in-place branch and one active checkout writer. Never create a worktree.
- Reads are side-effect free. They do not create `.workit/`, repair bytes, migrate records, reclaim ownership, or start a model session.
- Store readable snapshots only in `.workit/tasks/<id>.json` and `.workit/workspace.json`; keep recovery copies subordinate to those current records.
- Reject unknown fields, unsupported versions, malformed paths, stale revisions, forged provenance, and unsafe ownership transitions at the shared boundary.
- Preserve exact approval content bytes and provenance. A digest proves content identity, not approver identity or authority.
- Tests assert observable behavior at the shared boundary. Do not add coverage quotas, per-function tests, duplicated host copies of core tests, or assertions that only repeat constants and prose.
- Use the exact stable dependency baseline below and commit `bun.lock`. A later patch replaces a listed version only after the same compiler, deterministic, package, and host checks pass; never use a prerelease or floating development-tool selector.
- Distributed packages target Node.js `>=24` and must run without Bun. Bun remains a development/build/test tool; do not introduce Bun-only runtime APIs into shipped Node artifacts.
- OpenCode, Cursor, Codex CLI, Codex desktop, Pi, and Workit CLI must ship as one qualified release set. Capability assurance remains per surface: `enforced`, `agent_guided`, or `unavailable`.
- Do not run paid/live model evaluation, publish packages, change active user installations, or mutate optional external services without the separate authority and budgets required by the spec.
- Commit each task only after its focused tests and the affected typecheck pass. Never rewrite a task's reviewed commit range; append fixes.

### Locked dependency baseline

The registry audit was performed on 2026-09-04. “Keep” means the installed direct
version was already the newest compatible stable release; it is still pinned.

| Owner              | Exact v1 dependency action                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root toolchain     | Node CI/release `24.20.0`, package engines `>=24`, Bun/package manager `1.4.1`, `@types/bun` `1.4.1`, `@types/node` `24.13.3`, TypeScript `7.0.2`, oxfmt `0.66.0`, oxlint `1.81.0` |
| Shared contract    | Add Zod `4.5.4`; use `z.compile()` for the eight closed operation schemas and `z.toJSONSchema()` for MCP publication                                                               |
| Shared MCP         | Pin `@modelcontextprotocol/sdk` `1.30.0` and Zod `4.5.4`; use the low-level `Server`, not the draft-07-emitting high-level conversion path                                         |
| OpenCode           | Pin build-only `@opencode-ai/plugin` `1.18.27`; validate host `1.18.27`; ship no OpenCode SDK runtime dependency                                                                   |
| Pi                 | Pin development `@earendil-works/pi-coding-agent` `0.85.0`; peer `^0.85.0`; do not bundle Pi                                                                                       |
| Codex              | Qualify Codex CLI `0.153.2`; do not add it as a Workit runtime dependency; record the separate desktop build                                                                       |
| CLI UI             | Keep Ink `7.1.1`, `@inkjs/ui` `2.0.0`, React `19.2.8`, `@types/react` `19.2.18`, and `react-devtools-core` `7.0.1`                                                                 |
| Validation/release | Keep AJV `8.20.0`, `ajv-formats` `3.0.1`, semantic-release `25.0.9`, exec `7.1.0`, GitHub `12.0.9`, npm `13.1.5`, and release-notes generator `14.1.1`                             |

## Repository map and replacement boundary

Create these core units; do not create a service, interface, or package for every diagram box:

| File                                               | Responsibility                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/workit-core/src/core/task-contract.ts`   | Strict schemas, public types, canonical JSON, digests, IDs, and the eight closed request unions |
| `packages/workit-core/src/core/task-store.ts`      | Side-effect-free reads, short metadata lock, CAS updates, atomic snapshots, recovery copies     |
| `packages/workit-core/src/core/policy-resolver.ts` | Pure policy normalization, deterministic rules, requirement IDs, and policy diffs               |
| `packages/workit-core/src/core/task-evaluation.ts` | Candidate capture, evidence freshness, requirement evaluation, and closure evaluation           |
| `packages/workit-core/src/core/task-engine.ts`     | The eight purpose-specific operation families and core-owned state transitions                  |
| `packages/workit-core/src/core/authority.ts`       | Approval applicability plus reserve/consume/uncertain external-action transitions               |
| `packages/workit-core/src/core/workers.ts`         | Helper authority, worker lifecycle, cancellation reconciliation, and checkout writer gates      |
| `packages/workit-core/src/core/task-context.ts`    | Compact bootstrap/resume context and adaptive method selection                                  |

Reuse existing logger, path safety, repository context, Git, PR, YouTrack, changelog, and packaging code only where its behavior already matches the v1 contract. Do not reuse `readEffectiveFlowState` or its lock: it writes during reads and reclaims locks by age, both contrary to v1. Keep the old flow runnable only while the new slices are under construction. Task 18 removes the superseded flow, text detectors, fixed menus, universal Superpowers rails, and spec/plan-coupled handoff.

## Execution preflight

Implementation authority begins only after the user chooses an execution mode. At that point, stay in the current checkout, confirm that no unrelated user changes would enter the branch, create the guarded in-place branch `codex/workit-v1`, run `node_modules/.bin/oxfmt --check docs/workit-v1/spec.md docs/workit-v1/contracts.md docs/workit-v1/plan.md`, and commit the approved design artifacts before Task 1:

```bash
git switch -c codex/workit-v1
git add docs/workit-v1/spec.md docs/workit-v1/contracts.md docs/workit-v1/plan.md
git commit -m "docs: specify adaptive Workit v1"
```

If that branch name already exists or new unrelated changes are present, stop and reconcile the exact branch/files; do not overwrite, stash, or absorb them automatically.

---

### Task 1: Latest-compatible toolchain and strict shared contract

**Files:**

- Create: `packages/workit-core/src/core/task-contract.ts`
- Create: `test/workit-core/task-contract.test.ts`
- Create: `test/workit-core/task-fixtures.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.json`
- Modify: `packages/workit-core/package.json`
- Modify: `packages/workit-core/src/core.ts`
- Modify: `packages/workit-core/src/core/support-matrix.ts`
- Modify: `packages/workit-cli/package.json`
- Modify: `packages/workit-cursor/package.json`
- Modify: `packages/workit-opencode/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/windows-inner-suite-probe.yml`
- Modify: `test/workit-core/workspaces-scripts.test.ts`
- Modify: `test/artifacts/manifests.test.ts`
- Modify: `README.md`
- Modify: `packages/workit-cli/README.md`

**Interfaces:**

- Produces: the Node 24.20.0/Bun 1.4.1/TypeScript 7.0.2 development baseline and Node `>=24` distribution floor used by every later task.
- Produces: `SCHEMA_VERSION`, `POLICY_VERSION`, every serialized type from `contracts.md`, `OperationFamily`, `OperationRequest`, `operationSchemas`, `operationJsonSchema(family)`, `success`, `failure`, `parseOperation(family, input)`, `canonicalJson(value)`, `sha256(value)`, `newId()`, `newRevision()`, `decisionDigest(input)`, `candidateDigest(input)`, and `requirementId(input)`.
- Produces test builders `taskStartRequest()`, `assessment()`, `caller()`, `scope()`, and `ref()`; builders return valid values and accept shallow overrides.

- [ ] **Step 1: Add failing trust-boundary and compiled-schema parity tests**

```typescript
import { expect, test } from "bun:test";
import {
  canonicalJson,
  operationJsonSchema,
  operationSchemas,
  parseOperation,
} from "../../packages/workit-core/src/core/task-contract";
import { taskStartRequest } from "./task-fixtures";

test("rejects unknown payload fields instead of stripping them", () => {
  const result = parseOperation("task", { ...taskStartRequest(), surprise: true });
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  if (!result.ok) expect(result.details.fields?.[0]?.path).toBe("surprise");
});

test("canonical JSON sorts objects but preserves array and string bytes", () => {
  expect(canonicalJson({ z: ["e\u0301", "é"], a: 1 })).toBe('{"a":1,"z":["é","é"]}');
});

test("compiled operation parsing preserves the canonical schema result", () => {
  for (const fixture of operationCorpus()) {
    const raw = operationSchemas[fixture.family].safeParse(fixture.input);
    const compiled = parseOperation(fixture.family, fixture.input);
    expect(resultDataOrIssues(compiled)).toEqual(resultDataOrIssues(raw));
  }
});

test("MCP schemas are derived as JSON Schema 2020-12", () => {
  expect(operationJsonSchema("task").$schema).toBe("https://json-schema.org/draft/2020-12/schema");
});
```

Add cases for unsupported `schemaVersion`, unsafe/absolute/symlink-escaping scope paths, non-safe integers, invalid Unicode, duplicate environment names, malformed UUID/digest/timestamp values, and every closed action enum. The parity corpus needs representative valid and invalid input for every family and compares parsed data or normalized issue fields. Do not add a test that merely repeats a pinned version or constant declaration.

- [ ] **Step 2: Reproduce the contract and Bun 1.4.1 failures**

Run:

```bash
bun test test/workit-core/task-contract.test.ts
probe_cache="$(mktemp -d)"
npm_config_cache="$probe_cache" npm_config_ignore_scripts=false npx -y bun@1.4.1 test test/workit-core/workspaces-scripts.test.ts
npx -y --package=typescript@7.0.2 tsc --noEmit -p tsconfig.json
```

Expected: the contract test FAILs because `task-contract.ts` does not exist; the Bun 1.4.1 run has exactly the two Git-backed PR fixture failures reproduced during planning; TypeScript 7 exits 0. If the observed failures differ, stop and update the diagnosis before editing.

- [ ] **Step 3: Lock the toolchain and implement one strict schema source**

Set root `packageManager` to `bun@1.4.1`; pin TypeScript `7.0.2`, `@types/bun` `1.4.1`, `@types/node` `24.13.3`, oxfmt `0.66.0`, and oxlint `1.81.0`; keep the already-current direct versions from the locked baseline. Set every published package engine to `>=24`, update the support matrix and CI/release runners to Node `24.20.0` and Bun `1.4.1`, update current user-facing runtime documentation, and regenerate `bun.lock`. Do not add TypeScript 6, a dependency-update framework, or version-only tests.

In the two PR tests that prepend a stub `gh`/`glab`, stop deleting whole PATH directories that also contain `git`. The stub already wins by being first:

```typescript
PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ""}`;
```

Add Zod `4.5.4` as a direct core dependency and define strict schemas that mirror every field and operation in `contracts.md`. Infer exported TypeScript types from those schemas so adapters cannot maintain parallel handwritten payload types. Keep the uncompiled definitions canonical; compile only the eight closed operation schemas explicitly and derive JSON Schema only from the originals. Do not use the global `zod/compile` side-effect import, `z.validate()` where parsed data/issues are needed, or experimental `z.fromJSONSchema()`.

```typescript
import * as z from "zod";

export const SCHEMA_VERSION = 1 as const;
export const POLICY_VERSION = "1.0.0" as const;
export const OPERATION_FAMILIES = [
  "task",
  "policy",
  "evidence",
  "finding",
  "decision",
  "worker",
  "writer",
  "state",
] as const;

const compiledOperationSchemas = Object.fromEntries(
  OPERATION_FAMILIES.map((family) => [family, z.compile(operationSchemas[family])]),
) as typeof operationSchemas;

export function parseOperation(family: OperationFamily, input: unknown): Result<OperationRequest> {
  const parsed = compiledOperationSchemas[family].safeParse(input);
  return parsed.success ? success(null, null, parsed.data) : invalidInput(parsed.error);
}

export function operationJsonSchema(family: OperationFamily): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(operationSchemas[family], { target: "draft-2020-12" });
}
```

Use Node's `crypto.createHash("sha256")` and `crypto.randomUUID()`. Implement recursive key sorting directly; reject non-JSON values, invalid Unicode, unsafe numbers, and cycles rather than adding another canonicalization package. Candidate identity excludes reference IDs from environment identity and decision identity preserves exact presented/approved strings.

- [ ] **Step 4: Run the contract, new-runtime, and compiler checks**

Run:

```bash
probe_cache="$(mktemp -d)"
npm_config_cache="$probe_cache" npm_config_ignore_scripts=false npx -y bun@1.4.1 test test/workit-core/task-contract.test.ts test/workit-core/workspaces-scripts.test.ts
npx -y --package=typescript@7.0.2 tsc --noEmit -p tsconfig.json
```

Expected: PASS, including both previously failing PR fixture cases. The Node 24.20.0/Bun 1.4.1 CI jobs must also pass before this task's review is accepted; do not waive a failure as a toolchain issue.

- [ ] **Step 5: Commit the baseline and contract slice**

```bash
git add package.json bun.lock tsconfig.json packages/*/package.json packages/workit-core/src/core.ts packages/workit-core/src/core/support-matrix.ts packages/workit-core/src/core/task-contract.ts test/workit-core/task-contract.test.ts test/workit-core/task-fixtures.ts test/workit-core/workspaces-scripts.test.ts test/artifacts/manifests.test.ts .github/workflows README.md packages/workit-cli/README.md
git commit -m "feat(core): adopt the v1 toolchain and contracts"
```

### Task 2: Atomic project-local snapshot store

**Files:**

- Create: `packages/workit-core/src/core/task-store.ts`
- Create: `test/workit-core/task-store.test.ts`

**Interfaces:**

- Consumes: strict record schemas, `Result<T>`, IDs, revisions, and digests from Task 1.
- Produces: `TaskStore`, with `readTask`, `listTasks`, `readWorkspace`, `create`, `mutateTask`, `mutateWorkspace`, `mutateTaskAndWorkspace`, `recoveryCandidates`, `recoverTask`, and `recoverWorkspace`.
- Produces: `MutationContext = { now: Utc; revision: Revision }`, `TaskMutation = (task, context) => Result<TaskRecord>`, `WorkspaceMutation = (workspace, context) => Result<WorkspaceRecord>`, `CoupledMutation`, and `CoupledSnapshot`; only the store creates mutation time/revision values.

- [ ] **Step 1: Write the storage behavior test**

```typescript
test("reads never initialize or repair state", () => {
  const root = fixtureRoot();
  const store = new TaskStore(root);
  expect(store.listTasks()).toEqual(success(null, null, []));
  expect(existsSync(join(root, ".workit"))).toBe(false);
});

test("a stale task revision cannot overwrite a newer snapshot", () => {
  const { store, task } = startedStore();
  const first = store.mutateTask(task.id, task.revision, identityMutation);
  expect(first.ok).toBe(true);
  const stale = store.mutateTask(task.id, task.revision, identityMutation);
  expect(stale).toMatchObject({ ok: false, code: "revision_conflict" });
});
```

Add observable cases for atomic replacement failure preserving prior bytes, a leftover metadata lock returning `recovery_required`, corrupt current bytes remaining untouched, unsupported versions remaining untouched, post-recovery stale clients, and no cross-file success claim after a partial task/workspace update.

- [ ] **Step 2: Run the focused test and observe the missing store failure**

Run: `bun test test/workit-core/task-store.test.ts`

Expected: FAIL because `TaskStore` is missing.

- [ ] **Step 3: Implement the minimum local store**

```typescript
export class TaskStore {
  constructor(readonly root: string) {}
  readTask(taskId: Id): Result<TaskRecord>;
  listTasks(): Result<TaskRecord[]>;
  readWorkspace(): Result<WorkspaceRecord | null>;
  mutateTask(taskId: Id, expected: Revision, update: TaskMutation): Result<TaskRecord>;
  mutateWorkspace(expected: Revision, update: WorkspaceMutation): Result<WorkspaceRecord>;
  mutateTaskAndWorkspace(input: CoupledMutation): Result<CoupledSnapshot>;
}
```

Use `.workit/metadata.lock` created with `openSync(..., "wx")`. Store PID, process-start evidence when available, host, and a random nonce in the lock. Never clear it because of elapsed time. An explicit recovery path may clear it only after validating authority and establishing that the recorded process is stopped or explicitly accounted for.

Write `.workit/.gitignore` containing `*\n` on the first mutation, not on a read. Serialize to a unique temporary file in the destination directory, `fsync` it, preserve the prior validated bytes in `.workit/recovery/`, then `renameSync` atomically. A coupled mutation locks once, validates both revisions first, reserves the authoritative workspace state first, and reports uncertainty if the second replacement fails; it does not claim filesystem transactions.

- [ ] **Step 4: Run storage tests and the core typecheck**

Run: `bun test test/workit-core/task-store.test.ts && bunx tsc --noEmit`

Expected: PASS, including assertions that failed operations leave inspectable bytes.

- [ ] **Step 5: Commit the store**

```bash
git add packages/workit-core/src/core/task-store.ts test/workit-core/task-store.test.ts
git commit -m "feat(core): add atomic task snapshots"
```

### Task 3: Deterministic adaptive policy resolver

**Files:**

- Create: `packages/workit-core/src/core/policy-resolver.ts`
- Create: `test/workit-core/policy-resolver.test.ts`

**Interfaces:**

- Consumes: `Assessment`, `Intent`, `Constraint`, prior decisions/findings/requirements, normalization, digests, and `POLICY_VERSION`.
- Produces: `ResolverInput`, `resolvePolicy(input): Result<Policy>`, and `diffPolicy(previous, next, reason, now): PolicyChange | null`.
- `resolvePolicy` performs no filesystem, model, tool, clock, random, or network access.

- [ ] **Step 1: Encode the policy behavior table as failing tests**

```typescript
test("mechanical work does not inherit unrelated ceremony", () => {
  const result = resolvePolicy(resolverInput({ mechanicalLowRisk: true }));
  expect(requirementDimensions(result)).toEqual(["verification", "review"]);
  expect(requirementRules(result)).toContain("mechanical-existing-checks");
  expect(requirementRules(result)).not.toContain("durable-spec");
});

test("a tiny authorization change requires behavior evidence and fresh review", () => {
  const result = resolvePolicy(resolverInput({ behaviorChange: true, consequence: "security" }));
  expect(requirementRules(result)).toEqual(
    expect.arrayContaining(["behavioral-verification", "fresh-context-review"]),
  );
});
```

Cover CA-01 through CA-08: broad rename without size escalation, consequential unknown blocking only its dependent action, product choice requiring a decision, durable agreement vs coordination plan independently, helper usefulness independently, de-escalation with reasons, accepted tradeoff not reopening without new evidence, deterministic replay, malformed input, unknown input, and the contradictory `mechanicalLowRisk && behaviorChange` case failing reconciliation.

- [ ] **Step 2: Run the resolver test and observe the missing resolver failure**

Run: `bun test test/workit-core/policy-resolver.test.ts`

Expected: FAIL because `resolvePolicy` is missing.

- [ ] **Step 3: Implement the closed rule catalog**

```typescript
type Rule = (input: NormalizedResolverInput) => Requirement[];
const RULES: readonly Rule[] = [
  consequentialUnknownRule,
  productDecisionRule,
  behavioralChangeRule,
  mechanicalRule,
  durableAgreementRule,
  coordinationRule,
  helperRule,
  projectConstraintRule,
];

export function resolvePolicy(input: ResolverInput): Result<Policy> {
  const normalized = normalizeResolverInput(input);
  if (!normalized.ok) return normalized;
  const requirements = stableRequirements(RULES.flatMap((rule) => rule(normalized.data)));
  return success(null, null, {
    policyVersion: POLICY_VERSION,
    inputDigest: sha256(canonicalJson(normalized.data)),
    requirements,
  });
}
```

Rules emit independent requirements with stable IDs derived from rule ID, normalized scope, satisfaction, boundary, and dependent action. Preferences adjust only requirements whose constraints allow it. Unknowns produce scoped investigation/decision blockers; they never become false or a global maximum mode.

- [ ] **Step 4: Run resolver, contract, and type checks**

Run: `bun test test/workit-core/policy-resolver.test.ts test/workit-core/task-contract.test.ts && bunx tsc --noEmit`

Expected: PASS with identical replay bytes for identical normalized inputs.

- [ ] **Step 5: Commit the resolver**

```bash
git add packages/workit-core/src/core/policy-resolver.ts test/workit-core/policy-resolver.test.ts
git commit -m "feat(core): resolve adaptive work policy"
```

### Task 4: Task lifecycle, candidates, evidence, and truthful closure

**Files:**

- Create: `packages/workit-core/src/core/task-evaluation.ts`
- Create: `packages/workit-core/src/core/task-engine.ts`
- Create: `test/workit-core/task-engine.test.ts`
- Modify: `packages/workit-core/src/core.ts`

**Interfaces:**

- Consumes: Tasks 1-3 and `TaskStore`.
- Produces: `OperationContext = { root; caller; capabilities; constraints; now }`, `WorkitCore`, `captureCandidate(root, scope, environment)`, `evaluateEvidence(task, candidate)`, `evaluateRequirements(task, workspace, capabilities)`, and `evaluateClosure(requestedOutcome, view)`.
- Initially implements `task.*`, `policy.*`, and `evidence.record`; later tasks add the remaining families to the same `WorkitCore` class.

- [ ] **Step 1: Write lifecycle and evidence tests at the public boundary**

```typescript
test("passing repository checks cannot verify an untested behavior requirement", () => {
  const core = assessedBehaviorChange();
  core.evidence(recordPassingCheck({ claim: "repository check exits zero" }));
  const closed = core.task(closeRequest("verified"));
  expect(closed).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
});

test("inspection is byte-for-byte side effect free", () => {
  const { core, root } = activeTask();
  const before = snapshotBytes(root);
  expect(core.task(inspectRequest()).ok).toBe(true);
  expect(snapshotBytes(root)).toEqual(before);
});
```

Cover lifecycle `active -> paused -> active/closed`, stopped closure from either open state, refusal to reopen, current candidate including untracked/deleted/executable/symlink state, relevant edits making evidence stale, unrelated edits retaining established evidence, uncertain dependency scope going stale conservatively, RED evidence remaining historical, skipped/missing evidence requiring a reason, independent review requiring a separate host context, accepted limitations requiring permitted decisions, and CA-11, CA-12, CA-14, CA-25, and CA-26.

- [ ] **Step 2: Run the task-engine test and observe the missing engine failure**

Run: `bun test test/workit-core/task-engine.test.ts`

Expected: FAIL because `WorkitCore` is missing.

- [ ] **Step 3: Implement task and evaluation operations**

```typescript
export class WorkitCore {
  constructor(
    private readonly store: TaskStore,
    private readonly context: OperationContext,
  ) {}
  task(request: TaskRequest): Result<TaskSummary | TaskSummary[] | TaskView>;
  policy(request: PolicyRequest): Result<Policy | null>;
  evidence(request: EvidenceRequest): Result<Entry<Evidence>>;
}
```

`task.start` creates an active unassessed task. `policy.preview` is pure and does not write. `policy.assess` records the assessment, resolves constraints supplied by the trusted context rather than the payload, records an explicit policy diff, and stores the new policy. `task.close` computes the outcome and evidence IDs itself; the request cannot supply a completion flag.

Candidate capture uses `lstat`, exact file bytes, symlink target text, executable bits, relevant environment values, and Git HEAD only as context. It rejects scope escape and does not follow an out-of-scope symlink. Evidence freshness is derived on every view and closure evaluation, never written by a caller.

- [ ] **Step 4: Run the core vertical slice**

Run: `bun test test/workit-core/task-engine.test.ts test/workit-core/policy-resolver.test.ts test/workit-core/task-store.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle slice**

```bash
git add packages/workit-core/src/core.ts packages/workit-core/src/core/task-engine.ts packages/workit-core/src/core/task-evaluation.ts test/workit-core/task-engine.test.ts
git commit -m "feat(core): evaluate Workit task completion"
```

### Task 5: Decisions, findings, and one-time action authority

**Files:**

- Create: `packages/workit-core/src/core/authority.ts`
- Create: `test/workit-core/authority.test.ts`
- Modify: `packages/workit-core/src/core/task-engine.ts`
- Modify: `test/workit-core/task-engine.test.ts`

**Interfaces:**

- Consumes: `Decision`, `Finding`, caller provenance, task/workspace identity, revisions, and evaluation from Tasks 1-4.
- Produces: `WorkitCore.decision`, `WorkitCore.finding`, `ReserveActionInput`, `SettleActionInput`, `ActionReservation`, `reserveAction(input): Result<ActionReservation>`, `settleAction(input): Result<Entry<Decision>>`, and `applicableDecision(task, purpose, binding)`.
- Native adapters, not model payloads, call reserve/settle observation methods.

- [ ] **Step 1: Write authority failure tests**

```typescript
test("two invocations cannot use one bounded approval", () => {
  const first = reserveAction(approvedAction());
  expect(first.ok).toBe(true);
  expect(reserveAction(approvedAction())).toMatchObject({ ok: false, code: "permission_denied" });
});

test("an ambiguous external result blocks blind retry", () => {
  const reservation = reserveAction(approvedAction());
  settleAction(unknownOutcome(reservation));
  expect(reserveAction(approvedAction())).toMatchObject({
    ok: false,
    code: "external_outcome_unknown",
  });
});
```

Cover exact document-byte drift, unrelated decision edits remaining applicable, purpose mismatch, workspace/task/scope mismatch, rejected/revoked decisions, forged host-observed provenance, limitation acceptance only when allowed, fixed findings requiring verification, dismissal with evidence-backed reasons, deferred blockers requiring an applicable limitation decision, and new evidence reopening a finding.

- [ ] **Step 2: Run the authority tests and observe the missing transition failure**

Run: `bun test test/workit-core/authority.test.ts`

Expected: FAIL because reservation and settlement do not exist.

- [ ] **Step 3: Implement decision and finding reducers**

```typescript
export type ActionReservation = {
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  taskRevision: Revision;
};

export function reserveAction(input: ReserveActionInput): Result<ActionReservation>;
export function settleAction(
  input: SettleActionInput & { outcome: "succeeded" | "not_started" | "unknown" },
): Result<Entry<Decision>>;
```

Reservation occurs under the metadata lock before any external effect. `succeeded` consumes it, `unknown` preserves uncertain consumption, and `not_started` may release it only when native evidence establishes that no effect occurred. A bounded multi-step action records completed steps and cannot repeat them. Agent-callable `decision.record` cannot set digest, provenance, revocation, or consumption.

- [ ] **Step 4: Run authority and closure regression tests**

Run: `bun test test/workit-core/authority.test.ts test/workit-core/task-engine.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit authority handling**

```bash
git add packages/workit-core/src/core/authority.ts packages/workit-core/src/core/task-engine.ts test/workit-core/authority.test.ts test/workit-core/task-engine.test.ts
git commit -m "feat(core): bind decisions to bounded actions"
```

### Task 6: Scoped workers and single-checkout writer ownership

**Files:**

- Create: `packages/workit-core/src/core/workers.ts`
- Create: `test/workit-core/workers.test.ts`
- Modify: `packages/workit-core/src/core/task-engine.ts`

**Interfaces:**

- Consumes: `Assignment`, `Worker`, `Owner`, actual caller/session provenance, `TaskStore`, and requirements.
- Produces: `NativeWorkerObservation`, `WorkitCore.worker`, `WorkitCore.writer`, `observeWorkerLifecycle(input)`, and `assertProductWriteAllowed(input)`.

- [ ] **Step 1: Write worker and writer behavior tests**

```typescript
test("only one validated actor owns product writes", () => {
  expect(core.writer(acquireForLead()).ok).toBe(true);
  expect(core.writer(acquireForImplementer())).toMatchObject({
    ok: false,
    code: "writer_conflict",
  });
});

test("timeout does not prove a cancelling writer stopped", () => {
  observeWorkerLifecycle(cancellingWorker());
  expect(core.writer(acquireForReplacement())).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
});
```

Cover investigator/reviewer read-only assignments, implementer-only helper ownership, the lead as `workerId: null`, exact native session binding, helpers unable to record decisions/change scope/close/assign helpers/resolve blockers, bounded evidence and worker reports without writer ownership, mutation outside assigned paths, paused/closed task denial, uncertain process state, and ownership reservation surviving a coupled-write failure.

- [ ] **Step 2: Run the worker tests and observe the missing gate failure**

Run: `bun test test/workit-core/workers.test.ts`

Expected: FAIL because worker authority is not implemented.

- [ ] **Step 3: Implement worker reducers and the write gate**

```typescript
export function assertProductWriteAllowed(input: {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  caller: CallerContext;
  paths: string[];
}): Result<Owner>;

export function observeWorkerLifecycle(input: NativeWorkerObservation): Result<Entry<Worker>>;
```

Assignment is not launch. A native observation binds the actual worker session and state. `writer.acquire` checks active task, implementer role for helpers, exact caller identity, assignment scope, and current workspace ownership in one lock. Cancellation moves to `cancelling`; only observed process exit or explicit recovery can clear an uncertain owner.

- [ ] **Step 4: Run worker, store, and authority checks**

Run: `bun test test/workit-core/workers.test.ts test/workit-core/task-store.test.ts test/workit-core/authority.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit coordination**

```bash
git add packages/workit-core/src/core/workers.ts packages/workit-core/src/core/task-engine.ts test/workit-core/workers.test.ts
git commit -m "feat(core): coordinate one checkout writer"
```

### Task 7: Export, import, recovery, and compact continuity

**Files:**

- Create: `packages/workit-core/src/core/task-context.ts`
- Create: `test/workit-core/task-continuity.test.ts`
- Modify: `packages/workit-core/src/core/task-engine.ts`
- Modify: `packages/workit-core/src/core/task-store.ts`

**Interfaces:**

- Consumes: `ExportBundle`, task/workspace records, recovery preconditions, active decisions, current candidate, requirements, workers, and capability mappings.
- Produces: `WorkitCore.state`, `compactTaskContext(view): string`, and `reconcileResume(view, observations): Result<ResumeReconciliation>`.

- [ ] **Step 1: Write interruption and transfer tests**

```typescript
test("import creates paused continuity without destination authority", () => {
  const imported = destination.state(importRequest(sourceBundle));
  expect(imported).toMatchObject({ ok: true, data: { status: "paused" } });
  const view = inspectImportedTask(imported);
  expect(view.task.origin?.exportDigest).toBe(sourceBundle.digest);
  expect(view.task.decisions.every((entry) => entry.data.consumption === null)).toBe(true);
});

test("resume after external edits reports stale evidence and uncertain workers", () => {
  mutateRelevantFile();
  const result = reconcileResume(view(), nativeObservations());
  expect(result.staleEvidenceIds).not.toEqual([]);
  expect(result.blockers.map((item) => item.reason)).toContain(
    "worker state requires reconciliation",
  );
});
```

Cover export digest excluding its own digest field, no live ownership/credentials in exports, new destination IDs/revisions, imported provenance never authorizing work, unknown policy version requiring reassessment, explicit corrupt-byte CAS recovery, damaged bytes preserved, old revisions invalid after recovery, writer never restored active, closed history staying closed, and compact context containing decisions/gaps/next action once without a transcript.

- [ ] **Step 2: Run the continuity test and observe the missing state operations**

Run: `bun test test/workit-core/task-continuity.test.ts`

Expected: FAIL because state export/import/recovery is incomplete.

- [ ] **Step 3: Implement explicit state operations and resume reconciliation**

```typescript
export type ResumeReconciliation = {
  candidate: Candidate;
  staleEvidenceIds: Id[];
  workerUpdates: NativeWorkerObservation[];
  blockers: Progress["blockers"];
  reassessmentRequired: boolean;
};
```

`state.export` is read-only. `state.import` initializes only through an expected workspace revision and creates a paused task. `state.recover` compares `expectedBytes`, validates the selected current/recovery snapshot by digest and schema, preserves damaged bytes, verifies worker state/authority, and writes a fresh revision. It never converts a legacy flow record.

- [ ] **Step 4: Run all v1 core tests**

Run: `bun test test/workit-core/task-contract.test.ts test/workit-core/task-store.test.ts test/workit-core/policy-resolver.test.ts test/workit-core/task-engine.test.ts test/workit-core/authority.test.ts test/workit-core/workers.test.ts test/workit-core/task-continuity.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit continuity**

```bash
git add packages/workit-core/src/core/task-context.ts packages/workit-core/src/core/task-engine.ts packages/workit-core/src/core/task-store.ts test/workit-core/task-continuity.test.ts
git commit -m "feat(core): preserve compact task continuity"
```

### Task 8: Adaptive methods and compact bootstrap

**Files:**

- Create: `packages/workit-core/src/core/methods.ts`
- Create: `packages/workit-core/templates/workit-contract.md`
- Create: `packages/workit-core/skills/workit-challenge/SKILL.md`
- Create: `packages/workit-core/skills/workit-behavioral-tdd/SKILL.md`
- Create: `packages/workit-core/skills/workit-review/SKILL.md`
- Create: `packages/workit-core/skills/workit-plan/SKILL.md`
- Create: `packages/workit-core/skills/workit-implement/SKILL.md`
- Create: `packages/workit-core/skills/workit-debug/SKILL.md`
- Create: `packages/workit-core/skills/workit-handoff/SKILL.md`
- Create: `test/workit-core/methods.test.ts`
- Modify: `packages/workit-core/src/core/skill-manifests.ts`

**Interfaces:**

- Consumes: current `Policy`, `TaskSummary`, requirement dimensions, and capability mappings.
- Produces: `MethodId`, `SelectedMethod = { id: MethodId; reason: string; assurance: Assurance }`, `METHODS`, `selectMethods(policy, capabilities): SelectedMethod[]`, `invariantBootstrap(): string`, and the seven focused method skills.

- [ ] **Step 1: Write method-selection behavior tests**

```typescript
test("mechanical work loads no design or TDD method", () => {
  expect(selectMethods(mechanicalPolicy(), capabilities()).map((m) => m.id)).toEqual([]);
});

test("behavior change selects TDD and fresh review independently", () => {
  expect(selectMethods(behaviorPolicy(), capabilities()).map((m) => m.id)).toEqual([
    "workit-behavioral-tdd",
    "workit-review",
  ]);
});
```

Add cases for challenge without plan, plan without spec, a helper method without formal documents, unavailable independent review remaining a gap, stable ordering/no duplicates, and bootstrap text containing only invariant authority/state/tool guidance rather than every method.

- [ ] **Step 2: Run the method test and observe the missing registry failure**

Run: `bun test test/workit-core/methods.test.ts`

Expected: FAIL because `methods.ts` and the new skills are absent.

- [ ] **Step 3: Implement the closed method mapping and focused skills**

```typescript
export const METHODS = {
  "workit-challenge": { dimensions: ["challenge", "decisions"] },
  "workit-behavioral-tdd": { dimensions: ["testing"] },
  "workit-review": { dimensions: ["review"] },
  "workit-plan": { dimensions: ["artifacts", "continuity"] },
  "workit-implement": { dimensions: ["delegation"] },
  "workit-debug": { ruleIds: ["root-cause-investigation"] },
  "workit-handoff": { ruleIds: ["durable-handoff"] },
} as const;
```

The challenge skill treats proposals as hypotheses, separates facts/inferences/opinions/unknowns where consequential, recommends directly, and stops after settled decisions. The TDD skill uses stable behavioral boundaries and RED/GREEN vertical slices but explicitly rejects dependency-pin and implementation-mirroring tests. Review gets a stable candidate and real evidence, and findings are claims to investigate. Planning and handoff consume task state without requiring universal spec/plan ceremony. Skills call the shared operations; they do not implement a second lifecycle.

- [ ] **Step 4: Run method and manifest checks**

Run: `bun test test/workit-core/methods.test.ts test/artifacts/manifests.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit adaptive methods**

```bash
git add packages/workit-core/src/core/methods.ts packages/workit-core/src/core/skill-manifests.ts packages/workit-core/templates/workit-contract.md packages/workit-core/skills/workit-* test/workit-core/methods.test.ts
git commit -m "feat(core): select focused Workit methods"
```

### Task 9: Workit CLI over the shared operation families

**Files:**

- Create: `packages/workit-cli/src/task.ts`
- Create: `test/workit-cli/task-commands.test.ts`
- Modify: `packages/workit-cli/src/index.tsx`
- Modify: `packages/workit-cli/scripts/build.ts`
- Modify: `packages/workit-cli/package.json`

**Interfaces:**

- Consumes: `WorkitCore`, `OperationFamily`, strict operation schemas, and structured `Result<T>`.
- Produces: `runTaskCommand(argv, deps): Promise<number>`, all `workit <family> <action>` commands, and `workit handoff --task <id>` as a human-facing composition of state export plus compact destination context. `--json` preserves the exact result shape; human output is a projection.

- [ ] **Step 1: Write packed CLI behavior tests**

```typescript
test("task inspection works without a model or state mutation", async () => {
  const before = snapshotBytes(root);
  const result = await runCli(["task", "inspect", "--task", taskId, "--view", "full", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, schemaVersion: 1 });
  expect(snapshotBytes(root)).toEqual(before);
});

test("headless missing consent returns needs_input", async () => {
  const result = await runCli([
    "task",
    "resume",
    "--task",
    taskId,
    "--payload",
    "@resume.json",
    "--json",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "needs_input" });
});
```

Cover all 24 family/action names, `--payload @file` and `--payload -` for nested action data, `--task`, `--revision`, and `--workspace-revision` injection, malformed JSON, nonzero failures, human list/summary/policy-gap output, full evidence/decision/lifecycle/recovery access, handoff without a mandatory spec/plan, and a built tarball running on Node without Bun installed.

- [ ] **Step 2: Run CLI tests and observe the missing command failure**

Run: `bun test test/workit-cli/task-commands.test.ts`

Expected: FAIL because v1 commands are not dispatched.

- [ ] **Step 3: Implement one parser over the closed operation table**

```typescript
export async function runTaskCommand(argv: string[], deps: TaskCliDeps = {}): Promise<number> {
  const parsed = parseTaskArgs(argv);
  if (!parsed.ok) return printResult(parsed, deps);
  const core = new WorkitCore(new TaskStore(parsed.root), cliContext(parsed, deps));
  const result = dispatchCore(core, parsed.family, parsed.request);
  return printResult(result, deps);
}
```

The dispatcher accepts only the eight known family names and their schema-owned actions. It is not an arbitrary method caller or state patch. Keep the Ink setup wizard separate. CLI confirmation is `agent_reported` unless an actual TTY interaction is observed; a flag cannot fabricate host-attested human identity.

- [ ] **Step 4: Run source and packed CLI checks**

Run: `bun test test/workit-cli/task-commands.test.ts test/workit-cli/packed-cli.test.ts && bun run packages/workit-cli/scripts/build.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the CLI surface**

```bash
git add packages/workit-cli/src/task.ts packages/workit-cli/src/index.tsx packages/workit-cli/scripts/build.ts packages/workit-cli/package.json test/workit-cli/task-commands.test.ts
git commit -m "feat(cli): expose Workit v1 task control"
```

### Task 10: Shared MCP transport for Cursor and Codex

**Files:**

- Create: `packages/workit-mcp/package.json`
- Create: `packages/workit-mcp/src/server.ts`
- Create: `packages/workit-mcp/src/index.ts`
- Create: `packages/workit-mcp/scripts/build.ts`
- Create: `test/workit-mcp/server.test.ts`
- Create: `test/workit-mcp/process.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: `WorkitCore`, `parseOperation`, `operationJsonSchema`, structured results, `Host`, and adapter-supplied `NativeContextProvider`.
- Produces: `NativeContextProvider = { current(): Promise<OperationContext> }`, `createMcpServer(host, contextProvider)`, `runStdioServer(host)`, and one MCP tool named for each shared family: `workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, `workit_state`.

- [ ] **Step 1: Write transport mapping tests**

```typescript
test("MCP exposes exactly the eight family tools", () => {
  expect(toolNames(createTestServer("cursor"))).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ]);
  expect(
    listTools().tools.every(
      (tool) => tool.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema",
    ),
  ).toBe(true);
});

test("MCP cannot accept caller-supplied provenance", async () => {
  const result = await call("workit_evidence", {
    ...validEvidenceRequest(),
    provenance: forgedHostReceipt(),
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: false, code: "invalid_input" });
});
```

Cover protocol-only stdout, redacted diagnostics on stderr, workspace-root resolution, action schemas, structured domain errors marked `isError`, thrown errors contained, host value validation, read-only calls leaving bytes unchanged, a spawned stdio handshake, and `tools/list` publishing the exact core-derived draft-2020-12 schemas. Include a regression proving the server does not fall back to the SDK's current draft-07 Zod conversion.

- [ ] **Step 2: Run transport tests and observe the missing package failure**

Run: `bun test test/workit-mcp/server.test.ts test/workit-mcp/process.test.ts`

Expected: FAIL because `@brainervirus/workit-mcp` does not exist.

- [ ] **Step 3: Implement the shared MCP server**

```typescript
const server = new Server({ name: "workit", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: OPERATION_FAMILIES.map((family) => ({
    name: `workit_${family}`,
    description: operationDescription(family),
    inputSchema: operationJsonSchema(family),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const family = OPERATION_FAMILIES.find(
    (candidate) => request.params.name === `workit_${candidate}`,
  );
  if (!family) {
    return mcpResult({
      ok: false,
      schemaVersion: 1,
      code: "invalid_input",
      error: `Unknown Workit tool: ${request.params.name}`,
      details: { fields: [{ path: "name", reason: "unknown operation family" }] },
    });
  }

  const context = await contextProvider.current();
  const parsed = parseOperation(family, request.params.arguments);
  return mcpResult(
    parsed.ok
      ? new WorkitCore(new TaskStore(context.root), context)[family](parsed.data as never)
      : parsed,
  );
});
```

Create the package with exact direct dependencies on `@modelcontextprotocol/sdk` `1.30.0`, Zod `4.5.4`, and the workspace core. Use the low-level `Server` so Workit publishes the core's explicit draft-2020-12 schema; do not patch/vendor the SDK, duplicate JSON schemas, or use `McpServer`'s current draft-07 conversion path. The executable requires `--host cursor|codex_cli|codex_desktop`; adapters pass it rather than allowing model input to choose provenance. Share transport only. Cursor and Codex keep their own hooks, capability observations, session identity, and tests.

- [ ] **Step 4: Build and test the transport**

Run: `bun test test/workit-mcp/server.test.ts test/workit-mcp/process.test.ts && bun run packages/workit-mcp/scripts/build.ts && bunx tsc --noEmit`

Expected: PASS with no stdout before the MCP handshake.

- [ ] **Step 5: Commit the shared transport**

```bash
git add package.json tsconfig.json packages/workit-mcp test/workit-mcp
git commit -m "feat(mcp): share Workit family tools"
```

### Task 11: OpenCode native integration

**Files:**

- Create: `packages/workit-opencode/src/tools/workit.ts`
- Create: `test/workit-opencode/task-tools.test.ts`
- Create: `test/workit-opencode/task-hooks.test.ts`
- Modify: `packages/workit-opencode/src/tools/index.ts`
- Modify: `packages/workit-opencode/src/plugin.ts`
- Modify: `packages/workit-opencode/src/bootstrap.ts`
- Modify: `packages/workit-opencode/src/runtime.ts`
- Modify: `packages/workit-opencode/scripts/build.ts`
- Modify: `packages/workit-opencode/package.json`
- Modify: `test/shared/helpers/opencode-namespace.ts`
- Modify: `test/workit-opencode/smoke.ts`

**Interfaces:**

- Consumes: all core operation families, `compactTaskContext`, method selection, OpenCode native question receipts, session parentage, native `task` workers, compaction, and tool hooks.
- Produces: eight native Workit tools, OpenCode capability observations, direct-child worker binding, compact context restoration, native decision provenance, and controlled product-write interception.

- [ ] **Step 1: Write OpenCode-native contract tests**

```typescript
test("an unrelated question receipt cannot authorize a decision", async () => {
  receipts.record(unrelatedQuestionReceipt());
  const result = await tools.workit_decision.execute(decisionRecordInput(), nativeContext());
  expect(result).toMatchObject({ ok: false, code: "permission_denied" });
});

test("the lead is blocked from writes while an implementer owns the checkout", async () => {
  await expect(beforeToolCall(leadBashWrite())).rejects.toThrow("writer_conflict");
});
```

Cover native task tools rather than MCP, task discovery on session start, first-turn bootstrap once, compaction restoration once, purpose-specific receipt consumption, exact direct-child parentage, nested worker denial, reviewer read-only context, implementer scoped context, write interception for known edit/write/bash surfaces, cancellation observation, and truthful `agent_guided` labels for paths OpenCode cannot intercept. Compile and type-check against `@opencode-ai/plugin` `1.18.27` and run the packed smoke against OpenCode `1.18.27`.

- [ ] **Step 2: Run OpenCode tests and observe old-flow mismatches**

Run: `bun test test/workit-opencode/task-tools.test.ts test/workit-opencode/task-hooks.test.ts`

Expected: FAIL because the plugin still creates old flow tools and text-detector rails.

- [ ] **Step 3: Replace the plugin's workflow seam**

```typescript
return {
  tool: createWorkitTools(() => nativeOpenCodeContext(client, directory)),
  "tool.execute.after": observeQuestionAndWorkerResults,
  "tool.execute.before": enforceCurrentWriter,
  "experimental.session.compacting": restoreCompactTaskContext,
  "experimental.chat.messages.transform": injectInvariantContractOnce,
  config: registerSelectedSkillsAndNoWorktreePermission,
};
```

Do not carry forward phrase detectors such as “implementation without design” or a universal TDD/brainstorm reminder. Policy selects methods from structured task state. OpenCode receipts are host-observed only when the native question event, session, call, purpose, exact label/content, and time are actually available.

Pin `@opencode-ai/plugin` `1.18.27` as a development dependency, update the support matrix's tested OpenCode version, and keep it out of the published runtime dependency set.

- [ ] **Step 4: Run OpenCode, core, and packed-plugin checks**

Run: `bun test test/workit-opencode/task-tools.test.ts test/workit-opencode/task-hooks.test.ts test/workit-opencode/plugin.test.ts test/workit-opencode/smoke.ts.test.ts && bun run packages/workit-opencode/scripts/build.ts && bunx tsc --noEmit && opencode --version`

Expected: PASS; the host reports `1.18.27`, and the packed plugin loads without a runtime `@opencode-ai/plugin` dependency.

- [ ] **Step 5: Commit OpenCode parity**

```bash
git add packages/workit-opencode test/shared/helpers/opencode-namespace.ts test/workit-opencode/smoke.ts test/workit-opencode/task-tools.test.ts test/workit-opencode/task-hooks.test.ts
git commit -m "feat(opencode): apply adaptive Workit policy"
```

### Task 12: Cursor hooks, MCP, and native subagents

**Files:**

- Modify: `packages/workit-cursor/mcp/run-server.ts`
- Replace: `packages/workit-cursor/mcp/server.ts`
- Delete: `packages/workit-cursor/mcp/flow-evidence.ts`
- Create: `packages/workit-cursor/hooks/workit-hook.ts`
- Modify: `packages/workit-cursor/hooks/session-start.ts`
- Modify: `packages/workit-cursor/hooks/hooks-cursor.json`
- Replace: `packages/workit-cursor/rules/ask-question-only.mdc` with `packages/workit-cursor/rules/workit-contract.mdc`
- Modify: `packages/workit-cursor/mcp.json`
- Modify: `packages/workit-cursor/.cursor-plugin/plugin.json`
- Modify: `packages/workit-cursor/scripts/build.ts`
- Modify: `packages/workit-cursor/package.json`
- Replace: `packages/workit-cursor/skills/` with the seven canonical Task 8 method directories
- Create: `test/workit-cursor/task-mcp.test.ts`
- Create: `test/workit-cursor/task-hooks.test.ts`

**Interfaces:**

- Consumes: shared MCP server, Cursor hook events, native AskQuestion evidence where observable, Cursor-native subagent sessions, and core write/worker gates.
- Produces: Cursor capability observations and the same eight family tools with Cursor-specific provenance and assurance.

- [ ] **Step 1: Write Cursor mapping and assurance tests**

```typescript
test("Cursor MCP labels policy-only consent as agent guided", async () => {
  const view = await callCursor("workit_task", inspectInput());
  expect(capability(view, "interactive_decision").assurance).toBe("agent_guided");
});

test("a hook gap is not reported as enforced", () => {
  expect(cursorCapabilities(incompleteHookFixture())).toContainEqual(
    expect.objectContaining({
      name: "arbitrary_shell_write",
      assurance: "unavailable",
    }),
  );
});
```

Cover shared MCP request/response identity, session-start activation, resume/compaction context, hook failure behavior, supported write interception, one native subagent assignment and cancellation, reviewer vs implementer scopes, headless needs-input, mixed/absent hooks diagnosed, and no legacy delegation-token fallback.

- [ ] **Step 2: Run Cursor tests and observe the old server failures**

Run: `bun test test/workit-cursor/task-mcp.test.ts test/workit-cursor/task-hooks.test.ts`

Expected: FAIL because Cursor still embeds the 0.x MCP server and flow evidence.

- [ ] **Step 3: Connect Cursor to the shared server and native hooks**

```typescript
// packages/workit-cursor/mcp/run-server.ts
import { runStdioServer } from "@brainervirus/workit-mcp";
await runStdioServer("cursor", cursorContextProvider());
```

Use the documented Cursor hook events to observe only the surfaces they actually cover. MCP self-checks do not attest arbitrary editor/shell activity. Native subagents receive bounded assignments and report through Workit; only an implementer with the current writer reservation may mutate controlled paths.

Replace Cursor's direct MCP SDK and Zod dependencies with the workspace
`@brainervirus/workit-mcp` package. Cursor must not own a second schema stack or
retain the embedded server after this task.

- [ ] **Step 4: Build and run Cursor parity tests**

Run: `bun test test/workit-cursor/task-mcp.test.ts test/workit-cursor/task-hooks.test.ts test/workit-cursor/mcp-process.test.ts test/artifacts/cursor-marketplace.test.ts && bun run packages/workit-cursor/scripts/build.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit Cursor parity**

```bash
git add packages/workit-cursor test/workit-cursor/task-mcp.test.ts test/workit-cursor/task-hooks.test.ts
git commit -m "feat(cursor): map native adaptive workflow"
```

### Task 13: Codex CLI and desktop plugin

**Files:**

- Create: `packages/workit-codex/package.json`
- Create: `packages/workit-codex/.codex-plugin/plugin.json`
- Create: `packages/workit-codex/.mcp.json`
- Create: `packages/workit-codex/hooks/hooks.json`
- Create: `packages/workit-codex/hooks/workit-hook.ts`
- Create: `packages/workit-codex/scripts/launch-mcp.ts`
- Create: `packages/workit-codex/scripts/build.ts`
- Create: `packages/workit-codex/skills/workit-{challenge,behavioral-tdd,review,plan,implement,debug,handoff}/SKILL.md` by deterministic copy from Task 8
- Create: `test/workit-codex/plugin.test.ts`
- Create: `test/workit-codex/cli.test.ts`
- Create: `test/workit-codex/desktop.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: shared MCP, canonical skills, Codex plugin manifest/hooks, native task/subagent events available to the installed surface, and core worker/write gates.
- Produces: `CodexHost = "codex_cli" | "codex_desktop"`, `detectCodexSurface(env): CodexHost`, Codex capability observations, eight family tools, compact restore, and separate CLI/desktop qualification results.

- [ ] **Step 1: Write separate Codex surface tests**

```typescript
test("desktop and CLI provenance are never conflated", () => {
  expect(detectCodexSurface(desktopEnv())).toBe("codex_desktop");
  expect(detectCodexSurface(cliEnv())).toBe("codex_cli");
});

test.each(["codex_cli", "codex_desktop"] as const)(
  "%s exposes the shared policy identity",
  async (host) => {
    const result = await runCodexFixture(host, assessInput());
    expect(result.data.policyVersion).toBe("1.0.0");
    expect(result.data.requirements.map((r) => r.id)).toEqual(expectedRequirementIds());
  },
);
```

Cover manifest loading, MCP launch, hook event parsing, native question provenance when available, subagent launch/result/cancellation, writer enforcement scope, restart/compaction restore, missing hook/tool diagnostics, CLI headless needs-input, and desktop activation independently. Qualify CLI behavior on `0.153.2`; record the tested desktop build separately because it is not the CLI npm package. A test may record a capability unavailable; it may not silently skip a required baseline.

- [ ] **Step 2: Run Codex tests and observe the missing package failure**

Run: `bun test test/workit-codex/plugin.test.ts test/workit-codex/cli.test.ts test/workit-codex/desktop.test.ts`

Expected: FAIL because the Codex package is absent.

- [ ] **Step 3: Implement the native Codex package**

```typescript
export function detectCodexSurface(env: NodeJS.ProcessEnv): CodexHost {
  return env.CODEX_ELECTRON_RESOURCES_PATH ? "codex_desktop" : "codex_cli";
}

await runStdioServer(detectCodexSurface(process.env), codexContextProvider());
```

The manifest points at the shared skills, `.mcp.json`, and hook bundle. Codex CLI `0.153.2` is a qualification host, not a Workit dependency; do not add `@openai/codex` to the published package. Treat surface detection as adapter evidence and include it in diagnostics. Hook coverage and subagent lineage are tested against the actual supported Codex versions before claiming enforcement; instruction-only behavior remains `agent_guided`.

- [ ] **Step 4: Build and run both Codex suites**

Run: `bun run packages/workit-codex/scripts/build.ts && bun test test/workit-codex/plugin.test.ts test/workit-codex/cli.test.ts test/workit-codex/desktop.test.ts && bunx tsc --noEmit`

Expected: PASS for both named surfaces; unavailable capabilities remain explicit in their matrices.

- [ ] **Step 5: Commit Codex support**

```bash
git add package.json tsconfig.json packages/workit-codex test/workit-codex
git commit -m "feat(codex): add CLI and desktop integration"
```

### Task 14: Stock-Pi extension activation and task tools

**Files:**

- Create: `packages/workit-pi/package.json`
- Create: `packages/workit-pi/extensions/workit.ts`
- Create: `packages/workit-pi/src/tools.ts`
- Create: `packages/workit-pi/src/context.ts`
- Create: `packages/workit-pi/scripts/build.ts`
- Create: `packages/workit-pi/skills/workit-{challenge,behavioral-tdd,review,plan,implement,debug,handoff}/SKILL.md` by deterministic copy from Task 8
- Create: `test/workit-pi/extension.test.ts`
- Create: `test/workit-pi/session.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: Pi extension `registerTool`, `session_start`, `session_shutdown`, `before_agent_start`, `session_before_compact`, `session_compact`, `tool_call`, `tool_result`, `ctx.hasUI`, `ctx.ui`, and `ctx.sessionManager`; all shared core operations and skills.
- Produces: a Pi package manifest with `pi.extensions` and `pi.skills`, eight Workit tools, native session provenance, compact context restoration, interactive decisions, and headless `needs_input`.

- [ ] **Step 1: Write extension behavior tests against Pi 0.85.0 APIs**

```typescript
test("clean stock Pi loads Workit without a companion subagent package", async () => {
  const pi = fakePi();
  await extension(pi);
  expect(pi.registeredTools()).toEqual(expectedFamilyToolNames());
  expect(pi.requiredExternalExtensions()).toEqual([]);
});

test("headless Pi never simulates a required answer", async () => {
  const result = await executeDecisionTool({ hasUI: false }, decisionInput());
  expect(result.details).toMatchObject({ ok: false, code: "needs_input" });
});
```

Cover package discovery from `pi.extensions`, all eight tools, strict payloads, interactive `ctx.ui.select/confirm` receipts, session identity, resume/new/fork/reload events, compaction context once, hook blocking of known write tools, project trust, session shutdown cleanup, and explicit assurance that extensions are workflow controls rather than an OS sandbox.

- [ ] **Step 2: Run Pi extension tests and observe the missing package failure**

Run: `bun test test/workit-pi/extension.test.ts test/workit-pi/session.test.ts`

Expected: FAIL because `@brainervirus/workit-pi` does not exist.

- [ ] **Step 3: Implement the native extension**

```typescript
export default function extension(pi: ExtensionAPI) {
  registerWorkitTools(pi, () => piContext(pi));
  pi.on("session_start", restoreTaskBinding);
  pi.on("before_agent_start", injectCurrentContractAndMethods);
  pi.on("session_before_compact", preserveCompactTaskContext);
  pi.on("tool_call", enforceCurrentWriter);
  pi.on("tool_result", recordNativeObservation);
  pi.on("session_shutdown", cancelSessionResources);
}
```

Declare `@earendil-works/pi-coding-agent` `^0.85.0` as the peer range and pin `0.85.0` as the development fixture; bundle Workit's own runtime so a clean Pi installation needs no hidden companion. Do not bundle or fork Pi itself.

- [ ] **Step 4: Build and run Pi activation checks**

Run: `bun run packages/workit-pi/scripts/build.ts && bun test test/workit-pi/extension.test.ts test/workit-pi/session.test.ts && bunx tsc --noEmit`

Expected: PASS on the pinned development version.

- [ ] **Step 5: Commit Pi activation**

```bash
git add package.json tsconfig.json packages/workit-pi test/workit-pi/extension.test.ts test/workit-pi/session.test.ts
git commit -m "feat(pi): add native Workit extension"
```

### Task 15: Supervised stock-Pi workers and fresh review

**Files:**

- Create: `packages/workit-pi/src/worker.ts`
- Create: `packages/workit-pi/src/worker-protocol.ts`
- Create: `test/workit-pi/worker.test.ts`
- Create: `test/workit-pi/stock-pi.test.ts`
- Modify: `packages/workit-pi/extensions/workit.ts`
- Modify: `packages/workit-pi/src/tools.ts`
- Modify: `packages/workit-pi/scripts/build.ts`

**Interfaces:**

- Consumes: core worker assignments/writer reservations, the running Pi executable path, Pi JSON output, `AbortSignal`, and scoped method/task context.
- Produces: `PiRuntime`, `SpawnSpec`, `WorkerHandle`, `ObservedExit`, `launchWorker(assignment, options): WorkerHandle`, `cancelWorker(handle): Promise<ObservedExit>`, `parseWorkerResult(events): Result<WorkerReport>`, and extension commands/tools for assignment, cancellation, and fresh-context review.

- [ ] **Step 1: Write worker process behavior tests**

```typescript
test("reviewers receive no write-capable built-in tools", () => {
  expect(workerArgs(reviewerAssignment()).tools).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    ...expectedFamilyToolNames(),
  ]);
});

test("writer transfer waits for observed process exit", async () => {
  const worker = launchHungImplementer();
  await cancelWorker(worker, { graceMs: 10 });
  expect(workspace().writer?.state).toBe("uncertain");
  observeExit(worker, 143);
  expect(reconcileWorker(worker).ok).toBe(true);
});
```

Cover fresh stock-Pi process launch using the current runtime rather than a separately installed helper, structured JSON result collection, stderr preservation, reviewer read-only tools, implementer scope/writer reservation, model/auth inherited through Pi rather than Workit, success/failure/cancellation, SIGTERM then bounded escalation, timeout remaining uncertain until exit is observed, interrupted parent restart reconciliation, no nested worker launch, and a real local stock-Pi smoke with a deterministic fake provider/no paid network call.

- [ ] **Step 2: Run worker tests and observe the missing coordinator failure**

Run: `bun test test/workit-pi/worker.test.ts test/workit-pi/stock-pi.test.ts`

Expected: FAIL because the extension cannot launch or supervise workers.

- [ ] **Step 3: Implement the subprocess coordinator**

```typescript
export function workerCommand(runtime: PiRuntime, assignment: Assignment): SpawnSpec {
  return {
    command: runtime.node,
    args: [
      runtime.cli,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--tools",
      toolList(assignment.role),
      "--extension",
      runtime.workitExtension,
      "--",
      workerPrompt(assignment),
    ],
    cwd: runtime.root,
  };
}
```

Bind the native child PID/session to the assigned worker before accepting reports. Reserve writer ownership before launching an implementer. A reviewer never receives `bash`, `edit`, or `write`. On launch failure settle ownership as not started; on ambiguous launch/termination retain uncertainty. A worker report is not proof of process exit.

- [ ] **Step 4: Run the Pi worker and core coordination suites**

Run: `bun test test/workit-pi/worker.test.ts test/workit-pi/stock-pi.test.ts test/workit-core/workers.test.ts && bun run packages/workit-pi/scripts/build.ts && bunx tsc --noEmit`

Expected: PASS without network or credentials.

- [ ] **Step 5: Commit Pi workers**

```bash
git add packages/workit-pi test/workit-pi/worker.test.ts test/workit-pi/stock-pi.test.ts
git commit -m "feat(pi): supervise scoped stock Pi workers"
```

### Task 16: Optional Git, hosting, YouTrack, and documentation actions

**Files:**

- Create: `packages/workit-core/src/core/external-action.ts`
- Create: `test/workit-core/external-action.test.ts`
- Modify: `packages/workit-core/src/core/branch.ts`
- Modify: `packages/workit-core/src/core/pr-create.ts`
- Modify: `packages/workit-core/src/core/youtrack.ts`
- Modify: `packages/workit-core/src/core/changelog.ts`
- Modify: `packages/workit-core/src/core/repo-context.ts`
- Modify: `packages/workit-opencode/src/tools/workit.ts`
- Modify: `packages/workit-mcp/src/server.ts`
- Modify: `packages/workit-pi/src/tools.ts`
- Modify: `packages/workit-cli/src/task.ts`

**Interfaces:**

- Consumes: Task 5 action reservation, existing Git/GitHub/GitLab/YouTrack/docs functions, configured credentials, and native caller authority.
- Produces: `AuthorizedActionInput`, `ExternalActionResult`, and `runAuthorizedExternalAction(input, effect): Promise<Result<ExternalActionResult>>`; concrete branch/commit/push/PR, issue update, time log, changelog, release-note, and affected-doc operations use it directly.

- [ ] **Step 1: Write bounded external-action tests**

```typescript
test("one request can authorize its stated PR workflow without repeat prompts", async () => {
  const result = await runAuthorizedExternalAction(prWorkflow(), fakeRemote());
  expect(result.ok).toBe(true);
  expect(fakeRemote.calls).toEqual(["push", "create-pr"]);
  expect(questionCount()).toBe(0);
});

test("an uncertain remote write is reconciled before retry", async () => {
  fakeRemote.createPr.mockRejectedValueOnce(connectionDropped());
  const first = await runAuthorizedExternalAction(prWorkflow(), fakeRemote);
  expect(first).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  expect(await retryWithoutReconciliation()).toMatchObject({
    ok: false,
    code: "external_outcome_unknown",
  });
});
```

Cover missing optional credentials not blocking core work, unauthorized push/post/time actions, action scope/purpose mismatch, GitHub and GitLab routing, explicit branch policy, no worktrees, user-supplied/confirmed time duration only, no inferred agent-runtime time, optional meeting logging as a YouTrack convenience, no duplicate PR/comment/time entry after an ambiguous response, document drafts without publication, and separate external-action outcomes in delivery.

- [ ] **Step 2: Run integration-contract tests and observe unreserved writes**

Run: `bun test test/workit-core/external-action.test.ts test/workit-core/pr-create.test.ts test/workit-core/youtrack.test.ts`

Expected: FAIL because current external mutations do not use v1 reservations.

- [ ] **Step 3: Wrap concrete actions, not a generic integration framework**

```typescript
export async function runAuthorizedExternalAction<T>(
  input: AuthorizedActionInput,
  effect: () => Promise<T>,
): Promise<Result<T>> {
  const reserved = reserveAction(input);
  if (!reserved.ok) return reserved;
  try {
    return settleSucceeded(reserved, await effect());
  } catch (error) {
    return settleFromObservedOutcome(reserved, error);
  }
}
```

Each existing concrete function supplies its own reconciliation check and action reference. Do not create provider interfaces for one implementation or couple optional credentials to task assessment/inspection.

- [ ] **Step 4: Run optional integration and core regressions**

Run: `bun test test/workit-core/external-action.test.ts test/workit-core/pr-create.test.ts test/workit-core/youtrack.test.ts test/workit-core/branch.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit optional actions**

```bash
git add packages/workit-core/src/core/external-action.ts packages/workit-core/src/core/branch.ts packages/workit-core/src/core/pr-create.ts packages/workit-core/src/core/youtrack.ts packages/workit-core/src/core/changelog.ts packages/workit-core/src/core/repo-context.ts packages/workit-opencode packages/workit-mcp packages/workit-pi packages/workit-cli test/workit-core/external-action.test.ts
git commit -m "feat(core): bind optional external actions"
```

### Task 17: Preview-first configuration conversion, cutover, and rollback

**Files:**

- Create: `packages/workit-core/src/core/config-conversion.ts`
- Create: `packages/workit-core/src/core/cutover.ts`
- Create: `test/workit-core/config-conversion.test.ts`
- Create: `test/workit-core/cutover.test.ts`
- Modify: `packages/workit-core/src/core/setup.ts`
- Modify: `packages/workit-core/src/core/doctor.ts`
- Modify: `packages/workit-core/src/core/uninstall.ts`
- Modify: `packages/workit-cli/src/index.tsx`
- Modify: `packages/workit-cli/src/logic.ts`
- Modify: `packages/workit-cli/src/steps.tsx`
- Modify: `packages/workit-core/scripts/install-opencode-plugin.sh`
- Modify: `packages/workit-core/scripts/install-cursor-plugin.sh`
- Create: `packages/workit-core/scripts/install-codex-plugin.sh`
- Create: `packages/workit-core/scripts/install-pi-package.sh`

**Interfaces:**

- Consumes: existing Workit-managed config/registrations, new package manifests, process/session observations, explicit action decisions, and managed-file digests.
- Produces: `CutoverPlan`, `CutoverReceipt`, `previewConversion`, `previewCutover`, `applyCutover`, `previewRollback`, `applyRollback`, and doctor findings `legacy_component`, `mixed_generation`, `active_old_session`, `managed_content_conflict`, and `missing_v1_component`.

- [ ] **Step 1: Write no-surprise conversion and rollback tests**

```typescript
test("conversion preview is read only and redacts secrets", () => {
  const before = managedBytes();
  const preview = previewConversion(legacyFixtureWithSecret());
  expect(preview.unresolved.map((item) => item.key)).toContain("legacyWorkflowMode");
  expect(JSON.stringify(preview)).not.toContain("secret-value");
  expect(managedBytes()).toEqual(before);
});

test("rollback refuses to overwrite a subsequent user edit", () => {
  const cutover = applyFixtureCutover();
  editManagedFileAfterCutover();
  expect(applyRollback(cutover.backupId)).toMatchObject({ ok: false, code: "revision_conflict" });
});
```

Cover supported preference mappings, changed meanings requiring a choice, unsupported permissive values, credentials left in place, all 31 legacy workflow records untouched, new v1 task referencing old docs without importing authority, current source-linked OpenCode detection, Cursor `@latest` detection, old/mixed component refusal, unrelated settings preserved, active/unknown old session blocking activation, coherent host replacement, backup digests, partial activation reported, v1 data/repository work preserved on rollback, and no v1-to-0.x state conversion.

- [ ] **Step 2: Run cutover tests and observe the missing preview failure**

Run: `bun test test/workit-core/config-conversion.test.ts test/workit-core/cutover.test.ts`

Expected: FAIL because conversion and generation-aware cutover are absent.

- [ ] **Step 3: Implement explicit preview/apply boundaries**

```typescript
export type CutoverPlan = {
  id: Id;
  managedFiles: { path: string; beforeDigest: Digest | null; afterDigest: Digest }[];
  sessions: { host: Host; handle: string; state: "stopped" | "active" | "unknown" }[];
  unresolved: { key: string; reason: string }[];
};

export function applyCutover(plan: CutoverPlan, decision: Decision): Result<CutoverReceipt>;
```

Preview reads bytes and reports decisions without writing. Apply revalidates every before digest and session observation, backs up only Workit-managed content, installs one generation coherently per selected host, and refuses mixed activation. Rollback compares current managed bytes with the recorded installed digests before restoring. Do not change the user's active installation while implementing or testing; use hermetic fixture homes.

- [ ] **Step 4: Run setup, doctor, install, and cutover suites**

Run: `bun test test/workit-core/config-conversion.test.ts test/workit-core/cutover.test.ts test/workit-core/doctor.test.ts test/workit-core/install-scripts.test.ts test/workit-cli/wizard-config.test.ts && bunx tsc --noEmit`

Expected: PASS using only fixture directories.

- [ ] **Step 5: Commit the cutover mechanism**

```bash
git add packages/workit-core/src/core/config-conversion.ts packages/workit-core/src/core/cutover.ts packages/workit-core/src/core/setup.ts packages/workit-core/src/core/doctor.ts packages/workit-core/src/core/uninstall.ts packages/workit-core/scripts/install-*-plugin.sh packages/workit-core/scripts/install-pi-package.sh packages/workit-cli/src test/workit-core/config-conversion.test.ts test/workit-core/cutover.test.ts
git commit -m "feat(setup): add explicit v1 cutover and rollback"
```

### Task 18: Remove the 0.x workflow and ship one v1 package set

**Files:**

- Delete: `packages/workit-core/src/core/flow-state.ts`
- Delete: `packages/workit-core/src/state.ts`
- Delete: `packages/workit-core/src/core/detector.ts`
- Delete: `packages/workit-core/src/core/menu.ts`
- Delete: `packages/workit-core/src/core/reminder.ts`
- Delete: `packages/workit-core/src/core/handoff-context.ts`
- Delete: `packages/workit-core/src/core/handoff-tools.ts`
- Delete: `packages/workit-core/src/core/plan-tasks.ts`
- Delete: `packages/workit-core/src/core/sdd.ts`
- Delete: `packages/workit-cli/src/flow.ts`
- Modify: `packages/workit-core/src/core/branch.ts`
- Delete: `packages/workit-core/commands/`
- Delete: `packages/workit-core/skills/wk-{changelog,commit,docs-refresh,handoff,implement,init,issue-update,meetings,pr,release-notes,status,verify}/`
- Delete: `packages/workit-core/vendor/superpowers/`
- Delete: `packages/workit-core/scripts/update-superpowers.sh`
- Delete: `packages/workit-core/scripts/vendor-assets.ts`
- Delete: `packages/workit-core/templates/superpowers-doc-contract.md`
- Delete: `packages/workit-cursor/rules/cursor-todowrite.mdc`
- Delete: `packages/workit-cursor/rules/sdd-docs-path.mdc`
- Delete: legacy generated OpenCode commands/skills and Cursor vendored Superpowers copies; each adapter build keeps only Task 8 methods
- Delete: `test/workit-cli/flow-parity.test.ts`
- Delete: `test/workit-core/contracts.test.ts`
- Delete: `test/workit-core/enforcement-rails.test.ts`
- Delete: `test/workit-core/execution-reliability-parity.test.ts`
- Delete: `test/workit-core/flow-concurrency.test.ts`
- Delete: `test/workit-core/flow-enforcement.test.ts`
- Delete: `test/workit-core/flow-fixtures.ts`
- Delete: `test/workit-core/flow-state.test.ts`
- Delete: `test/workit-core/flow-tools.test.ts`
- Delete: `test/workit-core/handoff.test.ts`
- Delete: `test/workit-cursor/flow-enforcement.test.ts`
- Delete: `test/workit-cursor/flow-evidence.test.ts`
- Delete: `test/workit-opencode/flow-enforcement.test.ts`
- Delete: `test/workit-opencode/plugin-reminder.test.ts`
- Delete: `test/workit-core/vendor-superpowers.test.ts`
- Modify: `test/artifacts/opencode-skill-contract.test.ts`
- Modify: remaining imports and adapter registrations
- Modify: `package.json`
- Modify: all `packages/*/package.json`
- Modify: `release.config.cjs`
- Modify: `packages/workit-core/scripts/analyze-release-scope.ts`
- Modify: `packages/workit-core/scripts/rewrite-workspace-deps.ts`
- Modify: `packages/workit-core/scripts/sync-release-manifests.ts`
- Modify: `scripts/verify-release-candidate.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.cursor-plugin/marketplace.json`

**Interfaces:**

- Consumes: passing core, CLI, MCP, OpenCode, Cursor, Codex, Pi, integration, and cutover slices.
- Produces: only the v1 workflow surface; seven publishable workspace packages (`core`, `mcp`, `cli`, `opencode`, `cursor`, `codex`, and `pi`) are versioned and packed together, with host-native manifests and no runtime `workspace:*` dependency leakage.

- [ ] **Step 1: Add a release-candidate test that fails while legacy workflow files ship**

```typescript
test("the v1 candidate contains no 0.x workflow runtime", () => {
  const files = packedFiles();
  expect(files).not.toContain("src/core/flow-state.ts");
  expect(files.some((file) => file.includes("vendor/superpowers"))).toBe(false);
  expect(packageNames()).toEqual([
    "@brainervirus/workit-core",
    "@brainervirus/workit-mcp",
    "@brainervirus/workit-cli",
    "@brainervirus/workit-opencode",
    "@brainervirus/workit-cursor",
    "@brainervirus/workit-codex",
    "@brainervirus/workit-pi",
  ]);
});
```

Also assert no source import names the deleted modules, package builds copy only canonical Workit methods/templates, every internal dependency is rewritten to the same release version inside tarballs, Cursor and Codex manifests are version-synced, Pi declares its package resources, and release analysis treats every new package path as product code.

- [ ] **Step 2: Run the release-candidate test and observe legacy files/packages failing it**

Run: `bun test test/artifacts/release-candidate.test.ts test/artifacts/package-contents.test.ts`

Expected: FAIL until old runtime files are removed and new packages enter the release set.

- [ ] **Step 3: Delete superseded workflow code and update the release set**

Remove only modules and tests whose behavior is replaced by the approved v1 contract. Keep reusable Git, hosting, YouTrack, docs, config, logger, safe path, and presentation code when its tests still express valid v1 behavior. Update build/lint/format/typecheck paths, pack verification, semantic-release package bumpers, workspace-dependency rewriting, manifest sync, and CI matrices for all seven packages.

Re-audit direct dependencies against the registry before locking the candidate.
Keep the baseline versions unless a newer stable patch passes the same full
check; exclude prereleases, do not add transitive packages directly, and do not
use a broad `latest` selector in manifests or build tooling. Run `npm ls zod`
inside the isolated MCP candidate and resolve any mixed Zod major before release;
the behavioral schema and `tools/list` tests remain the proof, not an assertion
that a manifest contains a particular string.

The release job may build and pack candidates, but stable publication must remain gated by Task 19 qualification evidence. Do not preserve aliases for `workit flow`, old approval chains, legacy SDD ledgers, or old delegation tokens.

- [ ] **Step 4: Run the complete deterministic repository check**

Run: `bun run check && bun run verify:release-candidate`

Expected: PASS, producing seven local tarballs and performing no registry, marketplace, installation, or external-service writes.

- [ ] **Step 5: Commit the clean break**

```bash
git add -A packages test package.json tsconfig.json release.config.cjs scripts .github .cursor-plugin bun.lock
git commit -m "feat!: replace Workit workflow with adaptive v1 core"
```

### Task 19: Acceptance fixtures, host capability matrix, and release qualification gate

**Files:**

- Create: `test/acceptance/scenarios.ts`
- Create: `test/acceptance/judge.ts`
- Create: `test/acceptance/harness.ts`
- Create: `test/acceptance/deterministic.test.ts`
- Create: `scripts/run-v1-evaluation.ts`
- Create: `docs/workit-v1/capabilities.md`
- Create: `docs/workit-v1/qualification.md`
- Create: `.workit-evaluation/.gitignore`
- Modify: `scripts/verify-release-candidate.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: CA-01 through CA-32, E-01 through E-06, every adapter's observed capability fixtures, comparable native baselines, explicit model/run/wall-time/usage authorization, and deterministic release checks.
- Produces: `CodingHost = "opencode" | "cursor" | "codex_cli" | "codex_desktop" | "pi"`, fixed versioned scenario fixtures, observable-action judge results, a generated per-surface capability matrix, preserved run artifacts/dispositions, and a stable-release gate that cannot pass on missing or silently skipped required evidence.

- [ ] **Step 1: Write deterministic harness and release-gate tests**

```typescript
test("the qualification matrix is exactly 90 authorized Workit/native runs", () => {
  const plan = buildEvaluationPlan(authorizedBudget());
  expect(plan.mainRuns).toHaveLength(60);
  expect(plan.safetyRepeats).toHaveLength(30);
  expect(new Set(plan.runs.map(runIdentity)).size).toBe(90);
});

test("a missing or discarded failed run blocks stable release", () => {
  const report = qualificationReport({ missing: ["pi/E-05/repeat-2"] });
  expect(stableReleaseGate(report)).toMatchObject({ ok: false });
});

test("an unqualified toolchain or schema publication blocks stable release", () => {
  const report = qualificationReport({
    deterministicFailures: ["mcp_schema_dialect"],
  });
  expect(stableReleaseGate(report)).toMatchObject({ ok: false });
});
```

Cover fixed fixtures before execution, five coding hosts times six scenarios with and without Workit, two extra Workit repetitions for E-02/E-05/E-06 per host, CLI command-level acceptance without model runs, per-run host/model/Workit/policy/config/fixture identity, the exact Node/Bun/compiler/schema/SDK/host versions actually used, CA-31/CA-32 deterministic evidence, observable action scoring, questions/artifacts/tests/reviews/elapsed/usage recorded separately, failure preservation, targeted rerun rules, maximum-run/wall-time/usage enforcement including helpers, and external writes denied unless separately authorized.

- [ ] **Step 2: Run the deterministic harness tests and observe the missing evaluator failure**

Run: `bun test test/acceptance/deterministic.test.ts`

Expected: FAIL because the evaluation plan and stable gate are absent.

- [ ] **Step 3: Implement the evaluator without running live agents**

```typescript
export type EvaluationAuthorization = {
  models: Partial<Record<CodingHost, string>>;
  maxRuns: number;
  wallTimeMs: number;
  usageCeiling: { unit: "usd" | "tokens"; value: number };
  externalWrites: false;
};

if (!authorization || plannedRuns > authorization.maxRuns) {
  return failure("needs_input", "live evaluation requires an explicit bounded authorization");
}
```

Generate `capabilities.md` from adapter fixtures and make unknown/untested cells fail the applicable baseline rather than read as supported. `qualification.md` explains the exact commands and evidence format but contains no fabricated results. Store raw run artifacts under ignored `.workit-evaluation/`; commit only reviewed summaries and fixture definitions.

- [ ] **Step 4: Run deterministic checks and stop at the live-authorization boundary**

Run: `bun test test/acceptance/deterministic.test.ts && bun run check && bun run verify:release-candidate`

Expected: PASS for deterministic code and packaging. Do not invoke `scripts/run-v1-evaluation.ts` until the user separately supplies the permitted models, `maxRuns >= 90`, wall-time limit, and spending/usage ceiling.

- [ ] **Step 5: Commit the qualification machinery and product docs**

```bash
git add test/acceptance scripts/run-v1-evaluation.ts docs/workit-v1/capabilities.md docs/workit-v1/qualification.md .workit-evaluation/.gitignore scripts/verify-release-candidate.ts package.json README.md AGENTS.md CHANGELOG.md
git commit -m "test: gate Workit v1 on behavioral qualification"
```

## Final implementation verification

After Tasks 1-19 and before asking for live-evaluation authority:

1. Run `bun run check`.
2. Run `bun run verify:release-candidate` and inspect all seven tarball inventories.
3. Install each tarball only into a temporary fixture home and run its offline doctor/smoke check.
4. Run the shared CA-01 through CA-32 deterministic/adapter scenarios, including compiled/uncompiled schema parity and MCP draft-2020-12 publication.
5. Confirm `git status --short` contains only intended implementation, evidence-template, and documentation changes.
6. Request the explicit live-evaluation budget. Run the 90 qualification scenarios only after it is granted.
7. Record failures and dispositions, rerun only affected scenarios plus relevant regressions, and generate the final capability/qualification reports.
8. Promote/publish/install Workit 1.0 only under a separate explicit release action after every stable gate passes.

## Spec coverage map

| Spec area                                                    | Implemented by               |
| ------------------------------------------------------------ | ---------------------------- |
| Architecture, shared ownership, strict task contract         | Tasks 1, 2, 4                |
| Independent adaptive policy and two-way reassessment         | Task 3                       |
| PR-01 through PR-07 resolver invariants                      | Task 3                       |
| Authority, assurance, decisions, findings, truthful delivery | Tasks 4, 5                   |
| Behavioral TDD, challenge, review, planning, handoff         | Task 8 plus host Tasks 11-15 |
| Evidence freshness and candidate identity                    | Tasks 1, 4                   |
| Scoped helpers and one checkout writer                       | Tasks 6, 11-15               |
| Compact continuity, export/import, explicit recovery         | Task 7                       |
| Workit CLI inspection and lifecycle control                  | Task 9                       |
| Cursor and Codex MCP transport                               | Task 10                      |
| OpenCode, Cursor, Codex CLI/desktop, and Pi native behavior  | Tasks 11-15                  |
| Optional Git/hosting/YouTrack/docs actions                   | Task 16                      |
| Conversion preview, legacy continuation, cutover, rollback   | Task 17                      |
| Breaking removal and one release set                         | Task 18                      |
| Dependency/runtime baseline and Zod 4.5 compiled schemas     | Tasks 1, 10, 11, 14, 18, 19  |
| CA-01 through CA-32 and E-01 through E-06                    | Task 19                      |

The live 90-run batch and any stable publication remain outside implementation authority by design. Everything needed to run and judge them is part of Task 19; only their model, time, and spending authorization and resulting evidence must come later.
