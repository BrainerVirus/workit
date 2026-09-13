# Challenge redesign — Grounded grill loop

Approved design (F1): one fact-grounded question at a time, each with a
recommended answer and at least one rejected alternative; a bounded diverge
burst (3-5 directions, advisory artifact) when the approach is unknown; every
consequential resolution immediately followed by a receipt-shaped decision
(recorded at resolution time, never at close); facts answerable from code or
docs are never asked; durable spec only when the `durable-spec` requirement
fires; hard frontier/round budget; no new lifecycle.

## Method (what `workit-challenge` becomes)

1. Ground first: inspect task, policy, candidate, evidence, decisions, and the
   repo docs that exist. Facts are the agent's job — anything answerable from
   code or docs is never asked of the user.
2. Diverge once, bounded: when `approachUnknown` is true, produce 3-5 candidate
   directions with evidence and tradeoffs as a single advisory burst (recorded
   as artifact evidence), without critique; the user steers or mixes.
3. Grill: one question per round, each carrying the agent's recommended answer
   and at least one rejected alternative; resolve decision-tree dependencies in
   order; stop at an empty frontier or the hard cap (three rounds). The cap is
   the bound — the frontier alone is not a stopping rule.
4. Funnel every resolution: the moment a consequential choice resolves, bind it
   with a receipt-shaped question (`Workit decision: <purpose>`, exactly
   approved/rejected). If the user already stated the choice in conversation and
   no receipt can be minted, record the approval in task progress and reassess
   so the settled requirement retires — never re-ask to mint a receipt.
5. Durability: write or refresh the spec under `docs/<slug>/` only when policy's
   `durable-spec` requirement fires. No glossary, no ADR subsystem, no parallel
   lifecycle.
6. Critique discipline (P4-lite): each material recommendation carries one
   strongest counter-case (hidden assumption, failure mode, coupling, simpler
   alternative); stop when a counter-case adds no new constraint. Never claim
   fresh-context review from an in-session counter-case.

## Decision UX fixes (the knip close-time re-ask)

- The funnel moves receipt-shaped questions to the resolution moment; close is
  never the first place a receipt is demanded.
- Resolution already stated by the user without a receipt: record it in task
  progress, reassess with the settled signal, and proceed. The stale
  `product-decision` requirement retires through the normal policy diff instead
  of producing a redundant question.
- Multi-option receipts are deferred: the binary funnel covers current choices,
  and advisory shortlists stay non-binding. Revisit only if three-way choices
  become common.

## Implementation plan

1. RED: extend `test/workit-core/methods.test.ts` to pin the new structure
   (grounding, bounded diverge burst, receipt funnel, round cap, durability
   routing) and the absence of the old frontier-rounds-only wording.
2. Rewrite `packages/workit-core/skills/workit-challenge/SKILL.md`; run
   `bun run build` to sync the host skill copies.
3. Contract: add the funnel + no-re-ask rule to the decision rules in
   `AGENTS.md`; changelog entry.
4. GREEN: full suite, lint, typecheck, knip, build.
5. Deslop pass, worker review, close verified; the held v1 PR then batches the
   CI fixes plus this change.

## Out of scope

- N-option receipts, persona panels, path routing/one-way ratchets, glossary or
  ADR subsystems, core decision-record changes.
