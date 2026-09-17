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

## Phase 2 (follow-up task)

Chain reservation, content-ref intent binding generally, single
binding/pin/verify core, lifecycle gate table, idempotent cancel, explicit
revisions, schema-driven portability, self-identifying runtime, generated
adapters, policy-resolver fixes (enforce-or-remove `before:write`,
close-partition, kind-naming, RED-first scoping, reviewer uniqueness,
dead ruleIds, verification routing).

## Commit list (Phase 1, one atomic commit per task)

1. `fix(gates): session-scoped shell route denial with parity tests`
2. `fix(approvals): idempotent proposals with drift-gated validity`
3. `fix(approvals): stated-choice provenance and bindable branch proposals`
4. `docs(contract): structural Phase 1 denial, approval, and changelog updates`
5. Verification evidence only; no separate commit (re-recorded post-merge
   per babysit doctrine if the squash merge changes the candidate).
