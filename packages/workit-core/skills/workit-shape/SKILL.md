---
name: workit-shape
description: Shape work before building - brainstorm, grill open choices with a recommended answer, challenge weak premises, slice into PRs, propose a spec/ADR only when it pays. Use for brainstorm, plan, spec, design, options, should we, grill me.
---

# Shape the work

You own the facts; the user owns the choices. Read, run or prototype anything
observable before you ask. Skip all of this for a precise, settled request.

## 1. Classify out loud

- **Spike** (can we / how does it work): answer with evidence. No files.
- **Bounded** (change to an existing flow): a short design in chat, then build.
- **Architectural** (new subsystem or interface, cross-repo, hard to reverse):
  grill, then propose a record. Start light; escalate when a trigger fires.

## 2. Challenge gently, first

Challenge an unverified premise first; grill on the next turn, once it
settles. Say you will check, then check. Right? Say so. Wrong? Name what makes
sense in the idea, explain why it fails with evidence, and show the better way
with an example. At most one high-stakes assumption per turn: ask that one
question, then stop and wait. If you were wrong, say so with the proof. The
teaching tone stays in chat; code, commits and docs stay plain.

## 3. Diverge, then grill

Several viable approaches? Lay out two or three genuinely different ones (no
strawmen) with benefit, cost or risk, when each fits, and the smallest check
that settles it; recommend one. Then ask the whole frontier of open decisions
(every one whose prerequisites are settled), numbered, each with your answer:
`Q1 - <title>: <question>. Recommended: <answer>, because <evidence>.`
Dependent questions wait for the next round. If an authorized, reversible
default works, state it and proceed. Done when the frontier is empty and
nothing was silently assumed.

## 4. Durable knowledge only when it pays

Propose a record (never create one silently) when a trigger fires or the user
asks: a spec for multi-slice, cross-repo or open-product-choice work; an ADR for
a choice that is hard to reverse, surprising and a real trade-off; a glossary
entry for a term you had to resolve; `.out-of-scope/<concept>.md` for a rejected
request that will come back. A one-file mechanical fix gets none. Formats and
triggers: `references/knowledge.md`. Record each settled choice once:
`workit ledger decision "<what>" --why "<why>"`.

## 5. Slice as tracer bullets

Each slice is a thin path through every layer, verifiable alone, one PR, one
context window. Acceptance is Given/When/Then (workit-bdd makes it tests).
Dependent slices stack (`workit stack plan <bottom> ... <top>`); independent
ones go to workit-fanout. Plans record decisions, not code:
`references/slicing.md`. Diagrams and UI sketches only when they settle a
choice: `references/diagrams.md`, `references/mockups.md`.

Authorized to build? Continue into workit-implement. Do not ask for a
separate plan approval or repeat "continue?".

## Example

Bad: "Should the cache use Redis or Postgres?" (the agent never looked).
Good: "Q1 - Cache store: the stack already runs Postgres 16 (compose.yml) and
peak load is ~50 rps (measured: last week's metrics export). Recommended: a
Postgres table with a TTL column, because it adds no new service."

## Check

```sh
workit ledger list --type decision   # every settled choice is recorded
```
