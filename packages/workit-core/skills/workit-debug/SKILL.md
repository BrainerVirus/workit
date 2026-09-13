---
name: workit-debug
description: Use when behavior is failing, surprising, contradictory, or regressed and the root cause is not established
---

# Debug the root cause

Debugging is investigation, not a fast symptom patch. Use this method when
assessment selects `root-cause-investigation` or behavior is failing without an
established root cause.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

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

## Red-capable gate

Never hypothesize without a loop that goes red on this exact failure. Build
the loop first, in this order: failing test → CLI command + fixture →
request replay → trace. Tighten it until fast, sharp, deterministic, and
agent-runnable. No loop → stop, list what was tried, ask for the
environment or artifact; never theorize without it.

Minimise: cut one element at a time until every remainder is load-bearing;
the minimised case becomes the regression test. State hypotheses ranked and
falsifiable (`If <X> then changing <Y> removes it`), probe one variable at
a time, tag debug logs for grep cleanup. Write the regression at the seam
where the real pattern occurs — no correct seam means the finding is the
architecture, so flag it instead of patching around it.

When the host reports writer capability unavailable, do not mutate or delegate
mutation. Continue inline only if policy and lead authority permit it;
otherwise report the capability gap.

## Common mistakes

| Mistake                               | Correction                                             |
| ------------------------------------- | ------------------------------------------------------ |
| Patching the nearest stack frame      | Trace the input, callers, and shared cause.            |
| Reproducing only after editing        | Capture the failure before mutation.                   |
| Treating one passing command as proof | Verify the affected behavior and record real evidence. |
