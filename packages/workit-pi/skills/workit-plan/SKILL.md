---
name: workit-plan
description: Use when dependencies, sequencing, coordination, or resumption make durable next actions useful
---

# Plan useful coordination

Use a compact plan only when policy selects `artifacts` or `continuity`. A plan
organizes work; it is not a second lifecycle or a prerequisite for implementation.

## Method

1. Inspect current task state, scope, decisions, requirements, candidate, workers,
   findings, and blockers through the shared `task` and `policy` operations.
2. Record only the useful sequence: objective, dependency, bounded task, evidence
   needed, owner, and next action. Keep the plan against the existing system.
3. If policy separately requires a durable specification, record that behavior
   agreement; otherwise do not invent a spec. A plan without a spec is valid.
4. Update the shared task progress at meaningful boundaries. Reassess when facts,
   dependencies, or scope change; preserve unresolved blockers and decisions.

Use shared task/progress and evidence operations. Do not create a universal
spec-and-plan ceremony, duplicate task state, approval chain, or custom status
machine. A short paragraph is enough when it captures the required continuity.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Writing a full packet for a small dependency | Capture the next bounded action and its evidence. |
| Treating the plan as authority | Authority remains in task scope, decisions, revisions, and caller provenance. |
| Copying a transcript into the plan | Preserve decisions, gaps, blockers, and next action only. |
