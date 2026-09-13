---
name: workit-plan
description: Use when dependencies, sequencing, coordination, or resumption make durable next actions useful
---

# Plan useful coordination

Use a compact plan when assessment selects `artifacts` or `continuity`. A plan
organizes work; it is not a second lifecycle or a prerequisite for implementation.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Inspect current task state, scope, decisions, requirements, candidate, workers,
   findings, and blockers through the shared `task` and `policy` operations.
2. Record only the useful sequence: objective, dependency, bounded task, evidence
   needed, owner, and next action. Keep the plan against the existing system.
3. If policy separately requires a durable specification, record that behavior
   agreement; otherwise do not invent a spec. A plan without a spec is valid.
4. Update the shared task progress at meaningful boundaries. Reassess when facts,
   dependencies, or scope change; preserve unresolved blockers and decisions.
5. On steering (new instructions mid-task): apply `workit-steer` — park state
   verbatim, classify same-task / new-task / quick-question, handle, re-anchor.

Use shared task/progress and evidence operations. Do not create a universal
spec-and-plan ceremony, duplicate task state, approval chain, or custom status
machine. A short paragraph is enough when it captures the required continuity.

## Triage (automatic)

Set assessor signals from size facts, not memory (`triageTier` /
`triageSignals` in policy-resolver):

- **Large → spec + full plan:** new/changed observable behavior, open
  ambiguity, cross-package/host contract or auth/data/security surface,
  irreversible migration, or ≥3 subsystems / ≥2 packages touched.
- **Medium → compact plan-only** (Sequence/Acceptance, ~30-60 lines): known
  approach, single subsystem, 2-8 steps. Step count alone never escalates
  a known single-subsystem run to spec.
- **Small → neither** (progress + evidence only): single bounded mechanical
  action, no open choices, reversible. Record `Spec: none (reason)`.

`task.start` + `policy.assess` stay mandatory at all sizes. The lead may
re-tier with the reason recorded in progress (override, never silent).

## Decomposition

Slice tracer bullets, not layers: each plan task crosses the necessary
layers to a small demoable behavior with its blocking edges declared.
Wide refactors use expand–contract (add the new seam, migrate callers,
delete the old). Per task record Files (create/modify/test, exact paths),
exact commands with expected output, and one commit. No placeholders —
an implementer must be able to execute a task with zero extra context.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Writing a full packet for a small dependency | Capture the next bounded action and its evidence. |
| Treating the plan as authority | Authority remains in task scope, decisions, revisions, and caller provenance. |
| Copying a transcript into the plan | Preserve decisions, gaps, blockers, and next action only. |
