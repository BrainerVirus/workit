---
name: workit-behavioral-tdd
description: Use when policy identifies behavior, side effects, permissions, or data handling that may change and a regression boundary is needed
---

# Behavioral TDD

Test the observable behavior at a stable boundary, not the implementation shape.
Use this method when assessment selects the `testing` dimension.


## Method

1. Inspect the task requirement, current candidate, intended behavior, and real
   verification entry point with shared `task`, `policy`, and `evidence` operations.
2. State one behavior and its observable result. Choose the narrowest stable
   boundary a caller or user depends on; avoid private helpers and incidental
   representations.
3. Write one vertical RED slice that fails for the missing behavior and run it
   through the CLI so the failure is observed: `workit check test` (the repo's
   configured `test` check; `npx -y @brainervirus/workit-cli check test` when
   `workit` is not on PATH). Implement the smallest change, then run the same
   check GREEN. Close accepts only a fresh passing run of the configured check
   that `workit check` observed; a recorded "tests pass" is a note, and an
   ad-hoc `workit check -- <cmd>` never satisfies the gate. If no `test` check
   is configured or detected, add `workit.checks.json` (committed) with it.
4. Add only another slice for a distinct behavior or risk. Any edit makes the
   observed check stale: re-run `workit check test` before closing.

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

Run RED/GREEN through `workit check`, which records the observed result on the
current task; shared `evidence` operations are for notes and non-test evidence.
Do not add a second lifecycle, approval chain, or test workflow outside the
current task state.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| "The pin changed, so assert the new string" | Exercise the affected consumer behavior. |
| "The code is obvious" | A small vertical slice still proves the contract. |
| Keeping a passing test after the boundary moved | Re-run `workit check test` on the current tree. |
