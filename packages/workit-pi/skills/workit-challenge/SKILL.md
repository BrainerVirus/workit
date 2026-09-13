---
name: workit-challenge
description: Use when a proposal is ambiguous, consequential, disputed, or may hide assumptions, coupling, failure modes, or a simpler solution
---

# Challenge a proposal with a grounded grill

Treat the proposal as a hypothesis. Facts are the agent's job; decisions are
the user's. Use this method when assessment selects the `challenge` or
`decisions` dimension.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Ground first: inspect the task, policy, candidate, evidence, decisions, and
   the repo docs that exist. Never ask what code or docs can answer.
2. Diverge once, bounded: when the approach is unknown, offer 3-5 candidate
   directions with evidence and tradeoffs in one advisory burst, without
   critique. Record the burst as artifact evidence when it matters; the user
   steers or mixes.
3. Grill one question at a time: each question carries your recommended answer,
   the facts behind it, and at least one rejected alternative. Resolve
   dependency order and recompute after every answer — a wall of questions is
   not an interview.
4. Funnel every resolution: the moment a consequential choice settles, bind it
   with a receipt-shaped question (header `Workit decision: <purpose>`, exactly
   `approved`/`rejected`, the approved description carrying the exact content).
   If the user already stated the choice in conversation and no receipt can be
   minted, record it in task progress and reassess so the settled requirement
   retires — never re-ask to mint a receipt, and never leave it for close to
   demand.
5. Durability: write or refresh the spec under `docs/<slug>/` only when the
   `durable-spec` requirement fires. No glossary, no second lifecycle.
6. Counter-case: each material recommendation carries one strongest
   counter-case (hidden assumption, failure mode, coupling, simpler
   alternative). Stop when a counter-case adds no new constraint.

Stop at an empty frontier or three rounds; the cap is the bound. Say directly
when the proposal is weak, overcomplicated, or solves the wrong problem.

## Guardrails

- Do not create a universal spec, plan, approval chain, or second lifecycle.
- Unknowns that affect the dependent action remain unresolved until evidence or a
  user decision closes them.
- Use the shared operations for state and provenance; never write task metadata
  directly.
- An in-session counter-case is never fresh-context review; claim only what it is.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Asking what the code or docs already answer | Ground first; the user owns choices, not lookups. |
| Listing every hypothetical objection | One strongest counter-case, then stop. |
| Asking "what do you think?" without a recommendation | Recommend an option and explain the tradeoff. |
| Leaving a settled choice for close to confirm | Funnel it when it resolves; progress plus reassessment if no receipt. |
