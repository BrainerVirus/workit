---
name: workit-debug
description: Use when behavior is failing, surprising, contradictory, or regressed and the root cause is not established
---

# Debug the root cause

Debugging is investigation, not a fast symptom patch. Use this method when
assessment selects `root-cause-investigation` or behavior is failing without an
established root cause.


## Method

1. Inspect task scope, caller authority, candidate identity, existing evidence,
   findings, and worker state with shared `task`, `policy`, `evidence`, and
   `finding` operations.
2. Reproduce the failure at a stable behavioral boundary. Record observed facts,
   inferences, and unknowns with references; trace the failing value and all
   relevant callers before editing.
3. State the root-cause hypothesis and the smallest in-scope fix. Write a focused
   regression at the boundary when practical, then run RED and GREEN through
   `workit check <name>` so the results are observed, not reported.
4. Mutate within the host's own permissions. Reconcile the candidate, evidence, and findings after the change; investigate sibling paths
   and stale conclusions rather than assuming the first patch worked.

Respect the user's scope and native authority. For a deterministic failure, make
one focused reproduction that exercises the affected boundary and add a
regression check when practical. If no direct reproduction exists, gather the
available evidence and state what remains uncertain instead of inventing a red
loop or blocking unrelated work.

## Common mistakes

| Mistake                               | Correction                                             |
| ------------------------------------- | ------------------------------------------------------ |
| Patching the nearest stack frame      | Trace the input, callers, and shared cause.            |
| Reproducing only after editing        | Capture the failure before mutation.                   |
| Treating one passing command as proof | Verify the affected behavior and record real evidence. |
