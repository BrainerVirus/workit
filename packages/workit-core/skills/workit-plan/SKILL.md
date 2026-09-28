---
name: workit-plan
description: Use when dependencies, sequencing, coordination, or resumption make durable next actions useful
---

# Plan useful coordination

A plan is useful when work has dependent steps, a handoff, concurrent actors, or
meaningful unresolved choices. It is never a prerequisite for implementation.

## Method

1. Establish the requested outcome, constraints, dependencies, and important
   unknowns from the available code, docs, and configuration before asking.
2. Record only the useful sequence: objective, dependency, bounded outcome,
   evidence needed, and next action. Reuse the project's existing format.
3. Start a tracked record only when handoff, dependent steps, coordination, or
   durable decisions need continuity. Infer observable facts instead of asking
   the user to fill redundant protocol fields.
4. Create a spec when a durable behavior contract or interface is requested or
   will help a future reader. Use an ADR for a consequential trade-off and a
   glossary for stable terms. A small fix needs no document.
5. If the user authorized implementation, proceed through the agreed endpoint
   and applicable checks. Do not ask for a separate plan approval or repeat
   "continue?". Stop for a new consequential choice, host denial, conflict, or
   blocker that cannot be resolved safely.
6. Update a checkpoint at meaningful boundaries when another session may need
   to resume. Keep settled decisions, changed files, actual checks, blockers,
   and the next action; omit transcript and process trivia.

## Shape

Plan slices as small end-to-end outcomes with explicit dependencies and checks.
Keep repo policy and native host authority separate. Preserve the user's branch
and commit conventions. Do not prescribe one commit per step or create a second
approval chain unless the user asked for that delivery format.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Writing a packet for a bounded reversible change | Leave the change undocumented. |
| Asking what repository state or code can answer | Inspect it first. |
| Treating the plan as authority | Follow the user's scope and native host permissions. |
| Copying a transcript into the plan | Keep decisions, evidence, gaps, and next action only. |
