---
name: workit-debug
description: Use when behavior is failing, surprising, contradictory, or regressed and the root cause is not established
---

# Debug the root cause

Debugging is investigation, not a fast symptom patch. Use this method when the
`root-cause-investigation` rule is selected.

## Method

1. Inspect task scope, caller authority, candidate identity, existing evidence,
   findings, and worker/writer state with shared `task`, `policy`, `evidence`, and
   `finding` operations.
2. Reproduce the failure at a stable behavioral boundary. Record observed facts,
   inferences, and unknowns with references; trace the failing value and all
   relevant callers before editing.
3. State the root-cause hypothesis and the smallest in-scope fix. Write a focused
   regression at the boundary when practical, then run RED and GREEN checks.
4. Acquire writer authority through `writer` before mutation. Reconcile the
   candidate, evidence, and findings after the change; investigate sibling paths
   and stale conclusions rather than assuming the first patch worked.

Honor task status, scope, revisions, and native authority gates. Do not bypass
   them for an incident, create a second lifecycle, or claim a fix from a green
   command that did not exercise the affected behavior.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Patching the nearest stack frame | Trace the input, callers, and shared cause. |
| Reproducing only after editing | Capture the failure before mutation. |
| Treating one passing command as proof | Verify the affected behavior and record real evidence. |
