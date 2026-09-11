---
name: workit-challenge
description: Use when a proposal is ambiguous, consequential, disputed, or may hide assumptions, coupling, failure modes, or a simpler solution
---

# Challenge a proposal

Treat the proposal as a hypothesis to test, not a position to defend. Use this
method when assessment selects the `challenge` or `decisions` dimension.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

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

## Frontier rounds (bounded interview)

When the proposal needs user input, run frontier rounds: each round asks the
whole currently-askable set at once (`Qn — title: body` plus a
recommendation each), then recomputes. Facts are the agent's job — look up
what can be looked up, never ask it, and never block independent questions
on each other. Decisions are the user's. Stop at an empty frontier or three
rounds; confirm explicitly before acting. One native question, one receipt —
ask once, record, never re-ask to mint agreement.

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
| Asking "what do you think?" without a recommendation | Recommend an option and explain the tradeoff. |
