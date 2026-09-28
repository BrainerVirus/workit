---
name: workit-behavioral-tdd
description: Use when policy identifies behavior, side effects, permissions, or data handling that may change and a regression boundary is needed
---

# Behavioral TDD

Test the observable behavior at a stable boundary, not the implementation shape.
Use this method when assessment selects the `testing` dimension.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Inspect the task requirement, current candidate, intended behavior, and real
   verification entry point with shared `task`, `policy`, and `evidence` operations.
2. State one behavior and its observable result. Choose the narrowest stable
   boundary a caller or user depends on; avoid private helpers and incidental
   representations.
3. Write one vertical RED slice that fails for the missing behavior, run it, and
   preserve the actual failure as evidence. Implement the smallest change, then
   run the same slice GREEN and record its result. Close enforces the order: a
   testing requirement with GREEN but no preceding RED evidence stays unsatisfied.
4. Add only another slice for a distinct behavior or risk. Reconcile stale
   evidence if the candidate changes.

## Reject noisy tests

- A dependency/version-pin assertion is not behavioral evidence.
- A test that mirrors branches, private calls, or exact implementation structure
  is coupled to internals; replace it with the public effect.
- Duplicate assertions and tests that add no distinct failure signal are noise;
  delete them.
- Do not claim a passing test satisfies a different requirement.
- Banned: tautologies (asserts what the code says, not what it must do),
  ghost loops (assert inside a possibly-empty loop), smoke-only renders,
  type-only or CSS-class coupling. If the test still passes when every
  imported function returns undefined, rewrite the assertion or delete it.

Use shared `evidence` operations for RED/GREEN results. Do not add a second
lifecycle, approval chain, or test workflow outside the current task state.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| "The pin changed, so assert the new string" | Exercise the affected consumer behavior. |
| "The code is obvious" | A small vertical slice still proves the contract. |
| Keeping a passing test after the boundary moved | Mark it stale and retest the current candidate. |
