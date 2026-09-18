# Structural Fixes - Implementation Plan

**Spec:** `docs/structural-fixes/spec.md`
**Branch:** `feature/structural-fixes`

Phase 1 ships the user's lived pain: approval lifecycle (decisions 1–4)
and session-scoped enforcement (decision 6). Phase 2 (chain reservation,
state-machine unification, runtime identity, adapter generation, policy
fixes) follows as a separate tasked change.

## Phase 1 (this run)

### Task 1: Session-scoped shell route denial

- Core `shouldDenyShellRoute(attribution, command)`: single gate combining
  the existing session→task→checkout attribution with `shellRouteIntent`.
  `shellRouteIntent` stays a pure parser. Silent allow outside attributed
  sessions.
- Rewire the three deny sites to one-line callers passing what they hold:
  OpenCode session directory (cached per session ID),
  Pi `ctx.cwd`, Codex hook `cwd`.
- Tests: core unit (attributed/unattributed, branch + PR commands),
  per-host hook tests (deny inside / allow outside), parity test across
  OpenCode, Pi, Codex fixtures.

### Task 2: Idempotent proposals, drift-gated validity

- OpenCode adapter: re-resolution returns the existing pending proposal for
  the same `descriptorDigest` instead of minting a duplicate (one digest →
  at most one open question).
- Record-time validity by re-resolve byte-equality, not wall-clock: an old
  receipt revalidates when a fresh resolve produces the identical
  descriptor; only genuine drift fails closed. Clock remains for display
  age only. Restart loss stays fail-closed (deliberate safety default;
  durable proposals are Phase 2).
- Tests: RED (duplicate resolve → single question; aged approval + same
  bytes → accepted; aged approval + drifted bytes → rejected), then GREEN.

### Task 3: Stated choices and bindable dirty-tree proposal

- `stated_choice` provenance with conversation ref, sufficient authority
  for low-risk actions; adapter never re-asks a settled choice.
- Dirty-tree `branch_setup` resolves into a receipt-shaped proposal binding
  `stash: "yes"` instead of free-text guidance.
- `branch_setup` approval binds `(target_branch, base)` intent and
  re-resolves at execution; unrelated HEAD moves between approval and
  execution auto-carry with the fresh payload recorded as evidence.
- Tests for each behavior.

### Task 4: Contract docs and changelog

- `AGENTS.md`: denial bullet qualified to attributed sessions; approval
  lifecycle bullets updated (no clocks in validity, stated choices).
- `CHANGELOG.md` Unreleased entries per landed decision.
- Resolve this spec's supersession notes.

### Task 5: Verification and delivery

- Full `bun run check`, acceptance, release-candidate gates.
- Fresh-context review via one bounded reviewer; reconcile.
- Deslop pass, PR through `hosting.pull_request`, babysit to merge-ready.

## Phase 2 (this run)

**Branch:** `feature/structural-phase-2`

### Task 1: Policy-resolver fixes

- Enforce-or-remove `before:write`: either `writer.acquire` blocks while a
  `before:write` requirement is unsatisfied, or the value is dropped from
  the schema. No advisory-only gates.
- Close blocks only on `before:close` requirements; `before:dependent_action`
  blocks only its named action (deslop no longer gates `task.close`).
- Unsatisfied reasons name the expected evidence kind
  (e.g. "needs kind:check, got artifact"); `pre-pr-cleanup` accepts
  `artifact` as well as `check`.
- RED-first scoped to newly-added behavior claims; GREEN plus diff-scoped
  rationale satisfies otherwise.
- Reviewer-session uniqueness per requirement, not per task; `self-review`
  routed (add to `workit-review` ruleIds).
- Delete or retarget dead ruleIds (`root-cause-investigation`,
  `durable-handoff`); route the `verification` dimension.
- Tests: policy-resolver unit tests per fix, RED first.

### Task 2: Lifecycle gate table, idempotent cancel, and branch dirt classifier

- Split `activeWorkerBlocker` into `blocksPause` (freeze allowed with live
  workers; records candidate) vs `blocksResume/Close/Revise` (require
  certain workers plus writer-free), typed on `WorkerState` instead of
  `string`. Update the four call sites plus `task-context.ts`.
- `cancel` becomes idempotent and terminal: any live worker moves to
  `stopped` on lead-attested cancel without requiring a host observation;
  observations only move `dispatching → running → stopped`. Delete
  `cancelling`-as-persistent-state (keep at most a transient dispatch
  claim).
- Core `classifyBranchDirt`: untracked-only or `docs/`-confined dirt
  auto-carries (no stash question); all other dirt keeps the stash-bound
  proposal. Rewire the `branch.ts` dirty gate and the three adapter
  stash-upgrade sites to the single classifier.
- Tests: pause-with-workers, double-cancel idempotency, gate matrix, dirt
  classifier matrix (untracked / docs-confined / code dirt), carry
  end-to-end on one host, stash question preserved for real dirt.

### Task 3: Explicit revisions and schema-driven portability

- One revision field name (delete the `expectedTaskRevision` alias);
  explicit revisions required at the core boundary, adapters fill from
  their last read and surface the conflict.
- `reconcileResume` takes revisions like every other op instead of
  comparing against a stale view.
- Drive `portableTask`/`importedTask` from the zod schemas (allowlisted
  portable fields, sessions/receipts stripped generically); single resume
  path with `origin !== null` as a precondition, not a fork.
- Tests: revision-conflict matrix, export/import round-trip, resume paths.

### Task 4: Unified binding/pin/verify core

- Single `resolveBinding → checkPin → evaluateEvidence → isVerified`
  core used by evidence, finding, and close paths; no in-place input
  mutation; canonical-JSON ref compare (replace `JSON.stringify`
  equality); one finding-gate evaluator with one error code.
- Uniform staleness: artifact/investigation evidence binds like
  check/review (explicit policy decision, no implicit null exemption).
- Tests: pin-conflict matrix, staleness tiers, gate unification.

### Task 5: Single chain reservation

- One lease from `branch_setup` through plan commits to `pull_request`,
  carrying the snapshot; each step checks lease-still-valid instead of its
  own field list. Plan string lists become membership checks against the
  live plan (rewording without intent change needs no re-approval;
  plan-file change invalidates everything).
- Push-before-PR becomes the next step in the chain, not a special case.
- Tests: chain lifecycle, step membership, invalidation, lease expiry.

### Task 6: Self-identifying runtime and adapter consolidation

- Doctor and stale-install logic compare the running core bundle hash
  against the registry hash instead of parsing launcher argv, pins, and
  path spellings.
- Collapse the triplicated stash-upgrade blocks (OpenCode/Pi/CLI) into one
  core helper; adapters become one-line callers.
- Tests: hash-compare unit tests, stash-upgrade parity across adapters.

### Task 7: Contract docs and changelog

- `AGENTS.md`: gate-table, revision, chain, and policy-behavior bullets.
- `CHANGELOG.md` Unreleased entries per landed decision.

### Task 8: Verification and delivery

- Full `bun run check`, acceptance, release-candidate gates.
- Fresh-context review via one bounded reviewer; reconcile.
- Deslop pass, PR through `hosting.pull_request`, babysit to merge-ready.

## Commit list (Phase 2, one atomic commit per task)

1. `fix(policy): enforce gates, scope RED-first, route dead skills`
2. `fix(state): lifecycle gate table and idempotent cancel`
3. `fix(state): explicit revisions and schema-driven portability`
4. `fix(gates): unified binding, pin, and verify core`
5. `fix(actions): single chain reservation across branch, commits, and PR`
6. `fix(runtime): self-identifying runtime and core-owned stash upgrade`
7. `docs(contract): structural Phase 2 gates, revisions, chains, changelog`
8. Verification evidence only; no separate commit (re-recorded post-merge
   per babysit doctrine if the squash merge changes the candidate).

## Commit list (Phase 1, one atomic commit per task)

1. `fix(gates): session-scoped shell route denial with parity tests`
2. `fix(approvals): idempotent proposals with drift-gated validity`
3. `fix(approvals): stated-choice provenance and bindable branch proposals`
4. `docs(contract): structural Phase 1 denial, approval, and changelog updates`
5. Verification evidence only; no separate commit (re-recorded post-merge
   per babysit doctrine if the squash merge changes the candidate).
