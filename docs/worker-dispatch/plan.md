# Plan: worker dispatch mechanics

**Spec:** `docs/worker-dispatch/spec.md` · **Finding:** `a87c0bf5`

## Sequence

1. **Docs-first (no approval needed):** option D — one line on double-cancel
   recovery in AGENTS.md plus the review-session rule from spec §C. Smallest
   diff, immediate relief while the engine work lands.
2. **Option A — queued fan-out binding.** Core change is plugin-local
   (`prepareDispatch` queue + per-call settlement, existing
   `not_started` path reused). Tests pin: serial binds in order, no
   over-binding, races bind nothing. Needs a bounded reviewer (single
   worker, serial — the pattern that works today).
3. **Option B — scoped veto.** Change the `before`-hook predicate plus
   regression tests proving cross-task launches proceed while same-task
   launches stay vetoed. Security-sensitive: fresh-context review mandatory,
   and the reviewer must attempt a cross-task forgery proof.
4. **Reconcile + close:** reviewers verify A+B against this spec, findings
   resolve, full suite green.

## Acceptance

- Two reviewers assigned in parallel both record review evidence and report
  with no lead intervention (the exact scenario that failed twice).
- A `cancelling` worker on task X does not block a launch on task Y; it
  still blocks launches on task X until re-cancelled.
- Full `bun test` green; AGENTS.md documents the queue, the scoped veto,
  the review-session rule, and double-cancel recovery.
- Finding `a87c0bf5` resolves `fixed` with the check evidence.

## Ordering note

A before B: the queue changes which workers are eligible at each call, and
the veto tests must cover queued workers. D rides with either commit.
