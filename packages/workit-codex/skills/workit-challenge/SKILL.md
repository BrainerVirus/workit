---
name: workit-challenge
description: Use when a proposal is ambiguous, consequential, disputed, or may hide assumptions, coupling, failure modes, or a simpler solution
---

# Challenge a proposal

Treat the proposal as a hypothesis to test, not a position to defend. Use this
method only when policy selects the `challenge` or `decisions` dimension.

## Method

1. Inspect the current task, scope, candidate, constraints, and relevant evidence
   with the shared `task` and `evidence` operations.
2. Label consequential statements as `FACT` (observed reference), `INFERENCE`
   (reasoned from facts), `OPINION` (preference), or `UNKNOWN` (not established).
   Do not present an inference or opinion as fact.
3. Surface the hidden assumption, a simpler alternative, coupling, likely failure,
   and maintenance or operational consequence. Say directly when the proposal is
   weak, overcomplicated, or solves the wrong problem.
4. Recommend one option and state its tradeoff. Ask only for decisions that the
   user owns; record settled decisions with the shared `decision` operation.
5. Stop when the consequential choices are settled. Do not invent objections or
   keep debating to optimize for agreement.

## Guardrails

- Do not create a universal spec, plan, approval chain, or second lifecycle.
- Unknowns that affect the dependent action remain unresolved until evidence or a
  user decision closes them.
- Use the shared operations for state and provenance; never write task metadata
  directly.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Agreeing because the change is small or urgent | Check consequences, not line count or deadline. |
| Listing every hypothetical objection | Cover material coupling and failure modes, then stop. |
| Asking “what do you think?” without a recommendation | Recommend an option and explain the tradeoff. |
