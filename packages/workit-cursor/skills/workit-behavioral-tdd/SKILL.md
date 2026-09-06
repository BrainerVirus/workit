---
name: workit-behavioral-tdd
description: Use when policy identifies behavior, side effects, permissions, or data handling that may change and a regression boundary is needed
---

# Behavioral TDD

Test the observable behavior at a stable boundary, not the implementation shape.
Use this method when policy selects the `testing` dimension.

## Method

1. Inspect the task requirement, current candidate, intended behavior, and real
   verification entry point with shared `task`, `policy`, and `evidence` operations.
2. State one behavior and its observable result. Choose the narrowest stable
   boundary a caller or user depends on; avoid private helpers and incidental
   representations.
3. Write one vertical RED slice that fails for the missing behavior, run it, and
   preserve the actual failure as evidence. Implement the smallest change, then
   run the same slice GREEN and record its result.
4. Add only another slice for a distinct behavior or risk. Reconcile stale
   evidence if the candidate changes.

## Reject noisy tests

- A dependency/version-pin assertion is not behavioral evidence.
- A test that mirrors branches, private calls, or exact implementation structure
  is coupled to internals; replace it with the public effect.
- Duplicate assertions and tests that add no distinct failure signal are noise;
  delete them.
- Do not claim a passing test satisfies a different requirement.

Use shared `evidence` operations for RED/GREEN results. Do not add a second
lifecycle, approval chain, or test workflow outside the current task state.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| “The pin changed, so assert the new string” | Exercise the affected consumer behavior. |
| “The code is obvious” | A small vertical slice still proves the contract. |
| Keeping a passing test after the boundary moved | Mark it stale and retest the current candidate. |
