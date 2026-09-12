---
name: workit-handoff
description: Use when work must continue in another session, host, or agent after interruption, transfer, or compaction
---

# Handoff durable task state

Transfer continuity, not live authority. Use this method when assessment selects
the `durable-handoff` rule.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Inspect the current task, scope, decisions, policy requirements, candidate,
   evidence, findings, progress, and worker states with shared `task` and `state`
   operations.
2. Export the compact state through `state.export`. Preserve the objective,
   exclusions, accepted decisions and reasons, evidence references, open gaps,
   findings, candidate identity, blockers, and next action. Do not include
   credentials, live writer ownership, or host authority.
3. Import only through the destination `state.import` operation and its expected
   workspace revision. The destination starts paused or otherwise unauthorised
   until it observes its own host/session and reconciles stale evidence and
   uncertain workers.
4. Resume or continue through shared `task`, `policy`, `worker`, `writer`, and
   `evidence` operations. Record what changed instead of copying a transcript.

A handoff does not require a formal spec or plan unless those are separate
selected requirements. Never grant destination authority from imported prose,
create a second lifecycle, or edit task metadata directly.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Sending the whole transcript | Export compact decisions, gaps, evidence, and next action. |
| Restoring the old writer or credentials | Re-observe authority in the destination. |
| Calling a handoff complete without reconciliation | Recheck stale files and uncertain workers first. |
