# Workflow Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workflow-integrity/spec.md`
**Branch:** `bugfix/workflow-integrity`

**Goal:** Bind approvals to canonical document bytes, make execution and handoff context explicit, and expose the same fail-closed workflow outcomes through OpenCode, Cursor, and the CLI.

**Architecture:** Extend the existing `flow.json` aggregate and its optimistic compare-and-write seam in `flow-state.ts`; do not create a parallel state store or adapter-owned workflow logic. Effective reads normalize supported legacy data first, reconcile approval digests under the existing per-flow mutation critical section, and return structured drift. Lifecycle completion snapshots state and ledger coverage, runs the expensive repository verification outside the critical section, then compare-and-swap writes `completed` only when the persisted state still matches the snapshot.

**Tech Stack:** TypeScript 5.8, Bun test runner, Node.js 20+ built-ins (`node:crypto`, `node:fs`, `TextDecoder`), OpenCode plugin tools, Cursor MCP with Zod, Ink CLI, existing Workit core validators and `runVerifyProject`.

## Global Constraints

- Work only on `bugfix/workflow-integrity`; never use worktrees or change the guarded in-place branch model.
- Keep state normalization, validation, hashing, reconciliation, lifecycle transitions, ledger checks, verification orchestration, menu selection, and contract generation in `packages/workit-core/src/core/`; adapters only map host-native inputs and outputs.
- Add no dependency. Use `createHash("sha256")` from `node:crypto`, `TextDecoder("utf-8", { fatal: true })`, and the existing filesystem/CAS path.
- Hash the exact canonical file bytes after strict UTF-8 validation. Do not normalize line endings, Unicode, aliases, mirrors, or generated prompts.
- Canonical documents are only `docs/<slug>/spec.md` and `docs/<slug>/plan.md`; continue rejecting absolute paths, traversal, aliases, cross-slug pairs, wrong basenames, and symlink escapes through `resolveCanonicalLayout`.
- Persist compatibility for supported old `flow.json` shapes. Normalize missing optional fields only by the documented rules; malformed or unsupported state must return `flow_state_invalid` and preserve the original bytes.
- Extend the existing flow critical section and same-directory atomic replacement; do not introduce an adapter lock or a second state/locking system. Flush the temporary file before atomic rename and retain compare-and-swap conflict detection.
- Keep OpenCode coordinator/delegated identity derived from host parentage. Cursor remains policy-only with `attested: false` and still rejects subagent-driven mode.
- Support only execution states `pending`, `active`, `paused`, and `completed`; there is no cancellation operation or state.
- Keep all SDD state under canonical gitignored `docs/<slug>/sdd/` paths and preserve briefs, reviews, and progress across pause/resume.
- Maintain feature parity across OpenCode, Cursor, and CLI surfaces, with `workspace_root` required by repository-scoped Cursor calls.
- Do not perform Cursor release, runtime-pin, Marketplace submission, publication, or acceptance work. Tracked Cursor asset changes still require the existing Marketplace validator.
- Follow strict RED/GREEN TDD in each task: run the stated focused test command and observe the stated failure before editing production code, then rerun the same command to green.
- Do not create per-task commits. After all task reviews and verification, final commits use `wk-commit` only after its native `question` confirmation.

## Shared Interfaces

The first two tasks establish these exact names and shapes; later tasks consume them without host-specific variants:

```ts
export type FlowDocument = "spec" | "plan";
export type FlowDriftCode =
  | "digest_missing"
  | "document_missing"
  | "document_unreadable"
  | "digest_mismatch";
export type FlowDriftReason = {
  document: FlowDocument;
  code: FlowDriftCode;
  path: string;
};

export type ExecutionStatus = "pending" | "active" | "paused" | "completed";
export type ExecutionMode = "subagent-driven" | "inline";
export type CliConfirmation = {
  host: "cli";
  attested: false;
  confirmation: "flag" | "tty";
};
export type LifecycleEvidence = NativeChoiceEvidence | CliConfirmation;
export type FlowExecutionState = {
  status: ExecutionStatus;
  mode: ExecutionMode | null;
  evidence: LifecycleEvidence | null;
};

export type FlowDocState = {
  path: string;
  status: FlowStatus;
  evidence?: NativeChoiceEvidence | null;
  approved_digest: string | null;
};
export type FlowState = {
  slug: string;
  activated: boolean;
  spec: FlowDocState;
  plan: FlowDocState;
  menu: FlowMenuState;
  execution: FlowExecutionState;
  handoff_destination: boolean;
  updated_at: number;
};
export type EffectiveFlowState = {
  state: FlowState;
  drift: FlowDriftReason[];
};
export type FlowError = {
  ok: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
};
export type FlowReadResult = { ok: true } & EffectiveFlowState | FlowError;

export function readEffectiveFlowState(root: string, slug: string): FlowReadResult;
export function transitionExecution(
  root: string,
  slug: string,
  planPath: string,
  action: "pause" | "resume" | "complete",
  evidence: LifecycleEvidence,
  ctx?: MutationContext,
  deps?: { verifyProject?: typeof runVerifyProject },
): FlowGateResult;

export const HANDOFF_DESTINATION_MARKER =
  "<workflow-handoff-destination>true</workflow-handoff-destination>";
export function markHandoffDestination(
  root: string,
  slug: string,
  planPath: string,
): FlowGateResult;
```

The persisted property is exactly `approved_digest`; digests are 64-character lowercase hexadecimal SHA-256 values. `readFlowState` remains an internal/raw compatibility helper for controlled tests and mutation internals; status, gates, host adapters, and new commands use `readEffectiveFlowState`.

---

### Task 1: Core Hash-Bound Approval And Effective-State Reconciliation

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts:1-311, 678-981`
- Modify: `packages/workit-core/src/core/docs-layout.ts:85-170`
- Modify: `test/workit-core/flow-fixtures.ts:1-95`
- Modify: `test/workit-core/flow-state.test.ts:1-284`
- Modify: `test/workit-core/flow-concurrency.test.ts:1-492`
- Modify: `test/workit-core/docs-layout.test.ts:94-164`

**Interfaces:**
- Produces: `FlowDocument`, `FlowDriftCode`, `FlowDriftReason`, `FlowExecutionState`, `EffectiveFlowState`, `FlowReadResult`, `readEffectiveFlowState`, and `FlowDocState.approved_digest` exactly as declared in Shared Interfaces.
- Produces: one internal strict-byte helper that resolves a canonical document, reads a `Buffer`, validates it with fatal `TextDecoder`, and returns both decoded text and `createHash("sha256").update(bytes).digest("hex")`.
- Preserves: `prepareFlowState`, `transitionSpec`, `transitionPlan`, `recordMenuChoice`, `assertFlowGates`, and `assertProductGates` public names; each must reconcile before trusting persisted approval state.

- [ ] **Step 1: Write RED digest, drift, migration, and path-integrity cases**

Add named cases to `flow-state.test.ts` and shared fixture support to prove: fresh spec/plan approvals persist exact `approved_digest`; LF-to-CRLF and canonically equivalent but byte-different Unicode edits cause `digest_mismatch`; invalid UTF-8 returns `document_unreadable`; missing and unreadable canonical files produce their exact drift codes; spec drift resets spec, plan, both digests, menu evidence, `handoff_destination`, and execution to pending; plan drift preserves valid spec approval and digest while resetting plan-dependent state; approved legacy docs without a digest report `digest_missing`; the reconciled draft accepts a fresh approval without deleting `flow.json`; malformed JSON and unsupported field values return `flow_state_invalid` without changing the original bytes.

Add `docs-layout.test.ts` cases rejecting `./docs/<slug>/spec.md`, `docs/<slug>/../<slug>/spec.md`, repeated separators, absolute paths, traversal, and symlink escapes. In `resolveCanonicalLayout`, compare each caller path's POSIX spelling with the exact expected `docs/<slug>/spec.md` or `docs/<slug>/plan.md` after deriving the slug; return a structured path error before reading bytes when they differ.

Add concurrency cases that start from one approved snapshot and race reconciliation against a menu/approval mutation. Assert valid JSON, one winning state, no lost newer field, no shared `.tmp`, no remaining per-flow lock file, and preservation of the original file on parse/schema failure.

Use exact payload assertions such as:

```ts
expect(effective).toMatchObject({
  ok: true,
  drift: [{ document: "plan", code: "digest_mismatch", path: `docs/${slug}/plan.md` }],
  state: {
    spec: { status: "approved" },
    plan: { status: "draft", approved_digest: null, evidence: null },
    menu: { presented: false, chosen: "", evidence: null },
    execution: { status: "pending", mode: null, evidence: null },
    handoff_destination: false,
  },
});
```

- [ ] **Step 2: Run the focused core tests and verify RED**

Run: `bun test test/workit-core/flow-state.test.ts test/workit-core/flow-concurrency.test.ts test/workit-core/docs-layout.test.ts`

Expected: FAIL because `readEffectiveFlowState`, `approved_digest`, structured drift, strict UTF-8 validation, and lock/flush guarantees do not exist; existing approval fixtures also lack persisted digests.

- [ ] **Step 3: Implement strict hashing and effective-state reconciliation in the existing flow store**

In `flow-state.ts`, validate parsed state fields instead of coercing unsupported values. Normalize documented missing optional fields, then reconcile in spec-before-plan order. Use these reset cascades exactly:

```ts
const resetForSpecDrift = (state: FlowState): FlowState => ({
  ...state,
  spec: { ...state.spec, status: "draft", evidence: null, approved_digest: null },
  plan: { ...state.plan, status: "draft", evidence: null, approved_digest: null },
  menu: { presented: false, chosen: "", evidence: null },
  execution: { status: "pending", mode: null, evidence: null },
  handoff_destination: false,
  updated_at: Date.now(),
});

const resetForPlanDrift = (state: FlowState): FlowState => ({
  ...state,
  plan: { ...state.plan, status: "draft", evidence: null, approved_digest: null },
  menu: { presented: false, chosen: "", evidence: null },
  execution: { status: "pending", mode: null, evidence: null },
  handoff_destination: false,
  updated_at: Date.now(),
});
```

Store the digest atomically with approval evidence in `transitionSpec` and `transitionPlan`. Run reconciliation inside the same existing read/modify/write path before every transition and gate. A reapproval call that encounters stale approval first applies the reset, then validates and approves the readable unchanged canonical file in that same locked mutation.

Strengthen the current flow writer in place: acquire one per-flow `flow.json.lock` with `openSync(..., "wx")` for activation, effective read/reconciliation, and every read/reconcile/mutate/write critical section; on `EEXIST`, reuse `MAX_WRITE_ATTEMPTS` with `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)` and return `flow_concurrent_conflict` when exhausted. Retain the existing compare-and-swap conflict result, write a unique same-directory temporary file, `fsyncSync` its descriptor, close it, rename it, and best-effort remove temporary/lock files in `finally`. Do not add a lock module or adapter-side lock.

- [ ] **Step 4: Run the focused core tests and verify GREEN**

Run: `bun test test/workit-core/flow-state.test.ts test/workit-core/flow-concurrency.test.ts test/workit-core/docs-layout.test.ts`

Expected: PASS with fresh digests, exact-byte drift, deterministic cascades, fresh reapproval, malformed-state preservation, and atomic concurrent writes covered.

**Criteria:** CA-01, CA-02, CA-03, CA-04, CA-05, CA-06, CA-16, CA-18, CA-19, CA-20, and the hashing/reapproval/malformed/concurrency portion of CA-23 are demonstrated by the focused tests.

### Task 2: Core Execution Lifecycle And Active-Plan Detection

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts:73-112, 285-355, 832-981, 1644-1667`
- Modify: `packages/workit-core/src/core/detector.ts:165-218`
- Modify: `packages/workit-core/src/core/sdd.ts:37-131`
- Read/use unchanged: `packages/workit-core/src/core/verify-project.ts:10-64`
- Modify: `test/workit-core/flow-enforcement.test.ts:1-1296`
- Modify: `test/workit-core/flow-concurrency.test.ts:1-492`
- Modify: `test/workit-opencode/plugin-reminder.test.ts:22-351`

**Interfaces:**
- Consumes: `readEffectiveFlowState`, `FlowReadResult`, `FlowExecutionState`, `FlowError.details`, and the existing `parseTasksFromPlan`/SDD progress format.
- Produces: `ExecutionStatus`, `ExecutionMode`, `CliConfirmation`, `LifecycleEvidence`, and `transitionExecution` exactly as declared in Shared Interfaces.
- Produces: internal `ledgerCompletion(root, slug): { started: boolean; complete: boolean; required: number[]; completed: number[]; missing: number[] }` in `sdd.ts`, reused by lifecycle migration, completion, and active-plan detection. `started` is true only when the ledger contains at least one task progress record.
- Preserves: `findActiveSubagentDrivenPlans(root): string[]`, but it returns only effective `execution.status === "active" && execution.mode === "subagent-driven"` flows.

- [ ] **Step 1: Write RED lifecycle, migration, completion, and interception cases**

Add table-driven tests for the exact menu transitions: `subagent-driven` and `inline` set `{ status: "active", mode: choice }`; `handoff`, `review-spec`, and `review-plan` set `{ status: "pending", mode: null }`. Add pause/resume tests proving active-to-paused-to-active, retained mode/evidence, and untouched task briefs/reviews/progress. Add failures for pause from pending/completed, resume from active/pending/completed, missing evidence, drifted approvals, and unreadable docs.

Add legacy normalization fixtures with no `execution`: approved + `subagent-driven` + `ledgerCompletion.started === true` + incomplete ledger normalizes to active; missing/empty ledger and every other combination normalize to pending. In the same tests, omit approval digests and assert compatibility normalization occurs first but effective reconciliation then resets execution to pending with `digest_missing`.

Add completion tests with an injected verifier: incomplete ledger returns `code: "execution_incomplete"` and `details: { required, completed, missing }` without calling verification; failed verification returns `code: "verification_failed"` and `details.exitCode`; passing verification stores completed; a concurrent state change after verifier start returns `flow_concurrent_conflict` and does not overwrite the newer state. Assert the verifier is called outside the lock by making the injected function read status successfully while it is running.

Update detector/reminder/plugin fixtures so only active subagent-driven flows are found and intercepted. Explicitly assert pending, paused, completed, active inline, malformed, and drift-reset flows do not inject `SDD_REMINDER_TEXT` or block coordinator writes.

- [ ] **Step 2: Run the focused lifecycle tests and verify RED**

Run: `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts test/workit-opencode/plugin-reminder.test.ts`

Expected: FAIL because execution migration, `transitionExecution`, ledger completeness details, verification-backed completion, and lifecycle-aware plan detection are absent.

- [ ] **Step 3: Implement lifecycle normalization and transitions in core**

Normalize compatibility before digest reconciliation. For missing `execution`, derive active only when plan approval, `menu.chosen === "subagent-driven"`, `ledgerCompletion(...).started === true`, and `ledgerCompletion(...).complete === false` prove an in-progress legacy execution; otherwise derive pending. Reject persisted execution strings outside the four-state union.

Make `recordMenuChoice` set lifecycle atomically with menu evidence. Implement pause/resume under the existing per-flow critical section and validate `LifecycleEvidence`; OpenCode/ Cursor evidence uses existing validation, while CLI evidence accepts only the exact `CliConfirmation` shape.

For complete, use this ordering: acquire/read/reconcile/validate and capture the exact effective state plus ledger result; release; invoke `deps.verifyProject ?? runVerifyProject` with `dryRun = false`; stop on nonzero verification; reacquire and call the existing compare-and-swap write against the captured state; return `flow_concurrent_conflict` rather than rerunning verification or overwriting a concurrent mutation. No expensive command runs while the lock is held.

Replace detector-owned plan/ledger parsing with effective state plus `ledgerCompletion`; keep malformed states excluded without rewriting them. Make `assertCoordinatorBoundary` require active subagent-driven execution, not only a historical menu choice.

- [ ] **Step 4: Run the focused lifecycle tests and verify GREEN**

Run: `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts test/workit-opencode/plugin-reminder.test.ts`

Expected: PASS with all four lifecycle states, fail-closed migration, verified completion, concurrent completion rejection, and active-only reminder/interception behavior.

**Criteria:** CA-02, CA-11, CA-12, CA-13, CA-14, CA-15, CA-16, CA-17, CA-18, CA-19, CA-20, and the lifecycle/migration/resume/ledger/verification portion of CA-23 are demonstrated by the focused tests.

### Task 3: Core Handoff-Destination Contract

**Files:**
- Modify: `packages/workit-core/src/core/handoff-tools.ts:1-113`
- Modify: `packages/workit-core/src/core/handoff-context.ts:19-128`
- Modify: `packages/workit-core/src/core/flow-state.ts:103-110, 832-883`
- Modify: `packages/workit-core/src/core/reminder.ts:1-20`
- Modify: `packages/workit-core/templates/execution-contract.md:1-58`
- Modify: `packages/workit-core/templates/superpowers-doc-contract.md:52-64`
- Modify: `test/workit-core/handoff.test.ts:1-651`
- Modify: `test/workit-core/contracts.test.ts:99-142, 228-342`

**Interfaces:**
- Consumes: `FlowState.handoff_destination`, effective approval gates, pending handoff lifecycle, and the existing `handoffSession` stage result.
- Produces: `HANDOFF_DESTINATION_MARKER` and `markHandoffDestination` exactly as declared in Shared Interfaces.
- Produces: `SOURCE_MENU_CHOICES` with machine values `subagent-driven`, `inline`, `handoff`, `review-spec`, `review-plan`; `DESTINATION_MENU_CHOICES` is the same tuple without `handoff`.
- Produces: `buildHandoffPrompt(root, message)` destination contract containing the exact marker and display allow-list `Subagent-driven`, `Inline`, `Review spec first`, `Review plan first`.
- Extends: `HandoffRequest` with `afterSeed?: () => FlowGateResult | Promise<FlowGateResult>` and `HandoffData.stage` with `"mark"`, so OpenCode invokes destination marking after seed and before selection without adapter-owned state logic.

- [ ] **Step 1: Write RED source/destination, recursion, and failure-order cases**

Extend handoff tests to assert source contracts/reminders expose exactly five choices and destination contracts expose exactly four choices with no `Handoff` token in the allow-list. Assert every generated handoff prompt contains `HANDOFF_DESTINATION_MARKER`. Assert `markHandoffDestination` sets `handoff_destination: true`, resets menu to `{ presented: false, chosen: "", evidence: null }`, and leaves execution pending. Assert a direct `recordMenuChoice(..., "handoff", ...)` on a marked destination returns `code: "recursive_handoff"`.

For OpenCode orchestration fixtures, assert call/state order `create -> seed -> mark -> select`; create failure and seed failure leave flow unmarked and menu choice intact so one retry can rebuild/reseed; selection failure keeps the already seeded and marked destination. No delete/session rollback API exists, so a created-but-unseeded session ID remains in the existing stage error while flow state rolls back by never being marked.

In `contracts.test.ts`, compare exact source and destination choice arrays and scan canonical templates/reminders for stale destination five-choice wording.

- [ ] **Step 2: Run the focused handoff tests and verify RED**

Run: `bun test test/workit-core/handoff.test.ts test/workit-core/contracts.test.ts`

Expected: FAIL because the marker, destination flag mutation, four-choice contract, recursive rejection, and post-seed marking order do not exist.

- [ ] **Step 3: Implement the host-neutral destination contract and atomic marking**

Generate destination prompts from the canonical execution template with the exact sentinel on its own line and an explicit four-label allow-list. Select source/destination menu wording from `FlowState.handoff_destination` in reminder/contract helpers rather than duplicating strings in adapters.

Implement `markHandoffDestination` as one effective-state mutation: require approved spec/plan, require the source menu choice `handoff`, reject an already marked destination, set `handoff_destination: true`, reset menu presentation/evidence, keep execution pending, and use the existing lock/CAS writer.

Change OpenCode handoff orchestration so `handoffSession` invokes `request.afterSeed` only after `promptAsync` succeeds and before optional selection. Return `stage: "create" | "seed" | "mark" | "select"` details; create/seed/mark failures do not mutate destination state, while selection failure does not undo a successfully seeded and marked destination.

- [ ] **Step 4: Run the focused handoff tests and verify GREEN**

Run: `bun test test/workit-core/handoff.test.ts test/workit-core/contracts.test.ts`

Expected: PASS with portable destination marker, exact four-choice allow-list, recursive handoff rejection, menu reset, and deterministic OpenCode retry/rollback semantics.

**Criteria:** CA-02, CA-07, CA-08, CA-09, CA-10, CA-11, CA-20, and the handoff enforcement portion of CA-23 are demonstrated by the focused tests.

### Task 4: OpenCode Adapter Parity

**Files:**
- Modify: `packages/workit-opencode/src/tools/flow.ts:1-231`
- Modify: `packages/workit-opencode/src/tools/handoff.ts:1-59`
- Modify: `packages/workit-opencode/src/tools/index.ts:1-30`
- Modify: `packages/workit-opencode/src/plugin.ts:143-220, 287-339`
- Modify: `test/workit-opencode/flow-enforcement.test.ts:1-544`
- Modify: `test/workit-opencode/plugin.test.ts:30-313, 438-712`
- Modify: `test/workit-opencode/plugin-reminder.test.ts:22-351`

**Interfaces:**
- Consumes: `readEffectiveFlowState`, `transitionExecution`, `markHandoffDestination`, lifecycle/drift result fields, exact lifecycle labels, and active-only `findActiveSubagentDrivenPlans`.
- Produces native tools: `workflow_plan_pause`, `workflow_plan_resume`, and `workflow_plan_complete`, each with only `plan_path` in its schema and no caller evidence/role field.
- Consumes one-use question receipts with exact labels `Pause plan`, `Resume plan`, and `Complete plan` before invoking core.

- [ ] **Step 1: Write RED OpenCode tool, receipt, status, and interception cases**

Add schema/registration assertions for all three lifecycle tools. Drive the plugin's `tool.execute.after` hook with each exact label, assert one-use consumption, and assert wrong/negative/stale labels do not transition. Assert status returns `execution` and `drift` alongside spec/plan/menu.

Add end-to-end OpenCode cases for active -> paused -> active -> completed, incomplete-ledger and verification failure details, resume after drift returning pending, and preservation of coordinator/delegated parentage behavior. Add plugin interception/reminder cases proving only active subagent-driven state blocks/injects; stale, pending, paused, completed, and active inline flows remain usable.

Update handoff tests so a seeded OpenCode child receives the marker/four-choice contract, marking occurs after seed, and failed creation/seeding leaves the source retryable. Assert a destination reminder never offers Handoff.

- [ ] **Step 2: Run the focused OpenCode tests and verify RED**

Run: `bun test test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts test/workit-opencode/plugin-reminder.test.ts test/workit-core/handoff.test.ts`

Expected: FAIL because lifecycle tools are unregistered, status omits execution/drift, plugin rails use historical menu state, and destination orchestration is not wired.

- [ ] **Step 3: Map native OpenCode receipts and plugin behavior to core**

Create the three tools in `createFlowTools`; consume the session's most recent receipt with the exact expected label before `transitionExecution`, pass `opencodeMutationContext`, and return the standard `{ ok, data, error }` envelope with `execution`, `drift`, and structured failure `details`. Do not accept `confirmed`, evidence, role, or task identity arguments.

Use `readEffectiveFlowState` for status and all plugin active-plan checks. Preserve fail-closed session lookup and delegated-child bypass. Update `createTools` registration and the all-tools fixture. Wire OpenCode handoff to core destination marking only after successful seed and never offer Handoff when effective state is already a destination.

- [ ] **Step 4: Run the focused OpenCode tests and verify GREEN**

Run: `bun test test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts test/workit-opencode/plugin-reminder.test.ts test/workit-core/handoff.test.ts`

Expected: PASS with one-use lifecycle receipts, status drift/execution data, active-only interception, unchanged parentage semantics, and seeded destination behavior.

**Criteria:** CA-02, CA-04, CA-07, CA-08, CA-09, CA-10, CA-11, CA-12, CA-13, CA-14, CA-15, CA-16, CA-20, CA-21, and the OpenCode portion of CA-23 are demonstrated by the focused tests.

### Task 5: Cursor MCP Parity

**Files:**
- Modify: `packages/workit-cursor/mcp/server.ts:45-83, 780-838, 1172-1290`
- Read/use unchanged: `packages/workit-cursor/mcp/flow-evidence.ts:1-35`
- Modify: `test/workit-cursor/flow-enforcement.test.ts:1-322`
- Modify: `test/workit-cursor/mcp-regressions.test.ts:132-169, 193-253, 393-419`
- Modify: `test/workit-cursor/mcp-process.test.ts:17-59, 116-137`
- Modify: `test/workit-cursor/runtime-parity.test.ts:1-102`
- Modify: `test/workit-cursor/session-start.test.ts:1-141`

**Interfaces:**
- Consumes: the same `readEffectiveFlowState`, `transitionExecution`, `markHandoffDestination`, destination marker/choices, and `cursorMutationContext` used by OpenCode/core tests.
- Produces MCP tools: `workflow_plan_pause`, `workflow_plan_resume`, `workflow_plan_complete`, each requiring `plan_path` and `workspace_root`; confirmation remains the existing exact Cursor policy constant `{ host: "cursor", attested: false, confirmation: "contract" }`.
- Preserves: `workflow_plan_menu` rejection of `subagent-driven` with `CURSOR_SUBAGENT_UNSUPPORTED_TEXT`.

- [ ] **Step 1: Write RED Cursor lifecycle, drift, workspace, and destination cases**

Extend stdio tests to register/call all three lifecycle tools and assert active inline pause/resume/complete results match core shapes. Assert status includes identical `execution` and `drift`; incomplete ledger, verification failure, concurrent state change, and drifted resume return the same codes/details as core/OpenCode.

Assert every lifecycle/handoff call fails or resolves against its explicit `workspace_root`, and caller-supplied evidence/role remains inert. Keep the existing unsupported subagent-driven assertion.

For `workflow_handoff_prompt`, first record source choice `handoff`, then assert successful prompt generation contains the exact marker/four-choice allow-list, atomically marks destination, resets menu, and rejects a second recursive handoff. Assert build/validation failure leaves state unmarked. Update session-start/runtime contract assertions so a marked destination receives four choices and ordinary sessions retain five.

- [ ] **Step 2: Run the focused Cursor tests and verify RED**

Run: `bun test test/workit-cursor/flow-enforcement.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/runtime-parity.test.ts test/workit-cursor/session-start.test.ts`

Expected: FAIL because lifecycle MCP tools, structured status fields, post-generation destination marking, and destination-specific session contract behavior are absent.

- [ ] **Step 3: Register thin Cursor mappings to the shared core**

Add the three MCP registrations with explicit `workspace_root`, canonical plan resolution, `cursorConfirmation()`, `cursorMutationContext(workspace)`, and direct core result serialization. Do not parse ledgers, run verification, or reproduce transition rules in `server.ts`.

Change `workflow_handoff_prompt` to build the complete core prompt first, then call `markHandoffDestination`; if generation fails, return without mutation. Return prompt/tasks/SDD metadata plus effective destination state. Have the session-start contract select the core five/four wording from the exact marker in the incoming handoff prompt, without relying on session or parent IDs; retain policy-only evidence and unsupported subagent mode. Add all three tools to `REQUIRED_TOOLS` in `mcp-process.test.ts`.

- [ ] **Step 4: Run the focused Cursor tests and verify GREEN**

Run: `bun test test/workit-cursor/flow-enforcement.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/runtime-parity.test.ts test/workit-cursor/session-start.test.ts`

Expected: PASS with policy-only lifecycle tools, explicit workspace behavior, core-shaped drift/execution results, destination marking after prompt generation, and no Cursor subagent execution.

**Criteria:** CA-02, CA-04, CA-07, CA-08, CA-09, CA-10, CA-11, CA-12, CA-13, CA-14, CA-15, CA-16, CA-20, CA-21, and the Cursor portion of CA-23 are demonstrated by the focused tests.

### Task 6: CLI Flow And Handoff Parity

**Files:**
- Modify: `packages/workit-cli/src/index.tsx:1-176`
- Create: `packages/workit-cli/src/flow.ts` for the injectable command runner and TTY confirmation seam; keep `index.tsx` limited to dispatch and process exit.
- Modify: `test/workit-cli/packed-cli.test.ts:337-411`
- Create: `test/workit-cli/flow-parity.test.ts`

**Interfaces:**
- Consumes only core `readEffectiveFlowState`, `transitionExecution`, `buildHandoffPrompt`, `markHandoffDestination`, canonical path resolution, and `CliConfirmation`.
- Produces commands exactly: `workit flow status --plan <path>`, `workit flow pause --plan <path> [--confirm]`, `workit flow resume --plan <path> [--confirm]`, `workit flow complete --plan <path> [--confirm]`, and `workit handoff --message <text>`.
- Produces exit contract: `0` success, `1` domain/verification failure, `2` usage or missing non-TTY confirmation.

- [ ] **Step 1: Write RED CLI command, output, confirmation, and parity cases**

In `flow-parity.test.ts`, invoke an exported command runner with injected `stdinIsTTY`, `confirm`, and `verifyProject`; assert status prints JSON containing `slug`, spec, plan, menu, `execution`, and `drift`. Assert mutations in non-TTY mode return exit 2 and `--confirm required when stdin is not a TTY`; `--confirm` supplies `{ host: "cli", attested: false, confirmation: "flag" }`; a positive TTY prompt supplies confirmation `"tty"`; a negative TTY answer exits 2 without mutation.

Assert pause/resume/complete success and failure JSON matches core codes/details, including incomplete ledger and failed verification. Assert `workit handoff --message "docs/x/plan.md"` emits the core prompt to stdout, includes the exact destination marker/four-choice allow-list, marks only after successful generation, and exits 1 without marking on validation failure.

Extend packed CLI tests to assert help includes every exact command, non-TTY mutation confirmation behavior survives the packed Node bundle, status/handoff work from an extracted package, successful output is stdout-only, and domain/usage diagnostics are stderr with the documented exit codes.

- [ ] **Step 2: Run the focused CLI tests and verify RED**

Run: `bun test test/workit-cli/flow-parity.test.ts test/workit-cli/packed-cli.test.ts`

Expected: FAIL because the CLI currently exposes only `init` and `doctor`, with no shared-core flow/handoff command surface.

- [ ] **Step 3: Implement the minimum CLI parser and host confirmation mapping**

Parse the exact subcommands/flags without adding a command framework. Require one non-empty `--plan` or `--message`; reject unknown/missing flags with exit 2. Resolve workspace from `WORKFLOW_WORKSPACE_ROOT ?? process.cwd()`.

For mutation commands, use `--confirm` in non-TTY mode or one `readline/promises` yes/no prompt in TTY mode; map only affirmative confirmation to exact `CliConfirmation`. Call `transitionExecution` directly and serialize core success/failure fields without reimplementing prerequisites, ledger parsing, or verification. Status uses `readEffectiveFlowState`. Handoff builds the core destination prompt, then marks destination, then prints the prompt unchanged.

Update `HELP` and `packages/workit-cli/README.md` only in Task 7 after behavior is green.

- [ ] **Step 4: Run the focused CLI tests and verify GREEN**

Run: `bun test test/workit-cli/flow-parity.test.ts test/workit-cli/packed-cli.test.ts`

Expected: PASS from source and packed Node bundle with exact commands, confirmation/TTY rules, exit codes, structured lifecycle failures, and core-generated handoff output.

**Criteria:** CA-02, CA-04, CA-07, CA-08, CA-09, CA-10, CA-11, CA-12, CA-13, CA-14, CA-16, CA-20, CA-21, and the CLI/packed portion of CA-23 are demonstrated by the focused tests.

### Task 7: Generated Assets, Documentation, Changelog, And Full Parity Verification

**Files:**
- Regenerate: `packages/workit-opencode/assets/templates/execution-contract.md`
- Regenerate: `packages/workit-opencode/assets/templates/superpowers-doc-contract.md`
- Regenerate: `packages/workit-cursor/assets/templates/execution-contract.md`
- Regenerate: `packages/workit-cursor/assets/templates/superpowers-doc-contract.md`
- Regenerate: `packages/workit-cli/assets/templates/execution-contract.md`
- Regenerate: `packages/workit-cli/assets/templates/superpowers-doc-contract.md`
- Modify: `README.md:41-74, 179-218`
- Modify: `AGENTS.md:5-28`
- Modify: `CHANGELOG.md:19-53` through the `wk-changelog` workflow after native confirmation
- Modify where host behavior changed: `packages/workit-opencode/README.md:26-38`
- Modify where host behavior changed: `packages/workit-cursor/README.md:40-66`
- Modify where host behavior changed: `packages/workit-cli/README.md:17-44`
- Modify: `test/workit-core/contracts.test.ts:118-142, 228-342`
- Modify: `test/workit-cursor/runtime-parity.test.ts:14-102`
- Modify: `test/workit-cursor/mcp-regressions.test.ts:193-253, 393-419`
- Modify: `test/workit-cli/flow-parity.test.ts`

**Interfaces:**
- Consumes: canonical templates and all host surfaces completed in Tasks 1-6.
- Produces: byte-identical generated template copies across core/OpenCode/Cursor/CLI and one cross-host parity matrix covering success, drift reset/error payloads, destination restrictions, lifecycle transitions, and completion outcomes.

- [ ] **Step 1: Write RED parity and stale-contract assertions before regenerating assets**

Extend contract/parity tests to compare all four template roots byte-for-byte, require the exact destination marker, require the ordinary five-label list, require the destination four-label list, and fail if destination sections contain `Handoff`. Add one table that drives equivalent core/OpenCode/Cursor/CLI fixtures and compares normalized `{ spec, plan, menu, execution, handoff_destination, drift, code, details }` for fresh success, spec drift, plan drift, pause/resume, incomplete completion, failed verification, successful completion, and recursive handoff.

Run: `bun test test/workit-core/contracts.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-cli/flow-parity.test.ts`

Expected: FAIL because generated host assets and user documentation still contain the pre-integrity contracts and the final normalized parity table is not green.

- [ ] **Step 2: Regenerate tracked host assets with the existing build**

Run: `bun run build`

Expected: PASS and copy canonical templates into OpenCode, Cursor, and CLI asset roots without changing Cursor runtime pins or Marketplace metadata.

- [ ] **Step 3: Update user and maintainer documentation from implemented behavior**

Document exact-byte SHA-256 approval invalidation and fresh reapproval; normal five-choice versus destination four-choice menus and marker; pending/active/paused/completed semantics; active-only subagent interception; OpenCode receipts, Cursor policy-only confirmation, CLI `--confirm`/TTY behavior; CLI flow/handoff commands and exits; and shared-core parity. In `AGENTS.md`, update the capability table/parity rule without weakening the fixed `@brainervirus/workit-cursor@0.8.0` rule or claiming Marketplace publication.

Use `wk-changelog` to preview one Unreleased `Added` entry for lifecycle/CLI surfaces and one `Fixed` entry for digest drift, recursive handoffs, and stale interception; apply only after the workflow's native confirmation.

- [ ] **Step 4: Run focused core and host parity suites**

Run: `bun test test/workit-core/flow-state.test.ts test/workit-core/flow-concurrency.test.ts test/workit-core/docs-layout.test.ts test/workit-core/flow-enforcement.test.ts test/workit-core/handoff.test.ts test/workit-core/contracts.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts test/workit-opencode/plugin-reminder.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/runtime-parity.test.ts test/workit-cursor/session-start.test.ts test/workit-cli/flow-parity.test.ts test/workit-cli/packed-cli.test.ts`

Expected: PASS with no stale five-choice destination wording, no host-specific state logic, and normalized host outcomes equal.

- [ ] **Step 5: Run the complete repository quality gate**

Run: `bun run check`

Expected: exit 0 after build, lint, format check, all Bun tests, and `tsc --noEmit`.

- [ ] **Step 6: Run release-candidate and tracked Cursor asset gates**

Run: `bun run verify:release-candidate`

Expected: exit 0 with all packed packages and runtime artifacts validated without publishing.

Run: `bun run validate:cursor-marketplace`

Expected: exit 0 with tracked Cursor skills/rules/assets matching pinned official schemas; this is validation only, not Marketplace submission or release work.

- [ ] **Step 7: Review and create final commit(s) through the guarded workflow**

Use `workflow_git_context` to review only the intended implementation, tests, generated assets, README files, `AGENTS.md`, and CHANGELOG entries. Then load `wk-commit`, present its preview, ask the native confirmation question, and create final commit(s) only after confirmation. Do not create per-task commits and do not amend unless explicitly requested.

**Criteria:** CA-08, CA-10, CA-20, CA-21, CA-22, and CA-23 are demonstrated by byte-parity tests, cross-host outcome tests, updated documentation, full checks, packed release-candidate verification, and tracked Cursor asset validation. Together Tasks 1-7 cover CA-01 through CA-23.

## Status

| Status | Task |
| --- | --- |
| pending | 1: Core Hash-Bound Approval And Effective-State Reconciliation |
| pending | 2: Core Execution Lifecycle And Active-Plan Detection |
| pending | 3: Core Handoff-Destination Contract |
| pending | 4: OpenCode Adapter Parity |
| pending | 5: Cursor MCP Parity |
| pending | 6: CLI Flow And Handoff Parity |
| pending | 7: Generated Assets, Documentation, Changelog, And Full Parity Verification |
