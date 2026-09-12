---
name: workit-blast-radius
description: Use when a small-looking change could break something else, before close or merge
---

# Blast radius beyond the diff

A small diff is not a small risk. Prove the one fact it is safe because of,
with runnable proof — not assertion.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. List what the change touches: callers, shared state, contracts, config,
   migrations. Grep every caller of each touched function.
2. For each: state the one fact it is safe because of (type boundary,
   existing test, unreachable path) plus how to run the proof.
3. Run the proofs. Unproven claims stay labeled UNPROVEN in findings —
   never silently treated as safe.
4. Fix at the shared root (one guard where all callers route through),
   not per caller.

## Completion

Blast-radius note in evidence or review: each risk with fact + proof
command, or an UNPROVEN finding for what could not be proven.
