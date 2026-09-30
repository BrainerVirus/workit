---
name: workit-steer
description: Use when new instructions, interruptions, or forgotten items change substantial ongoing work
---

# Steer without forced lifecycle

Classify new input as a quick question, a same-task adjustment, or a separate
request. Preserve continuity when it helps; do not manufacture task mutations.

## Method

1. Answer a quick question from current context. Do not pause, resume, create,
   assess, or close a task just to answer it.
2. For a same-task adjustment, update only affected constraints and next actions.
   Keep an existing checkpoint when it helps; reassess policy only when evidence
   or constraints changed enough to affect a rule.
3. For a separate request, do not silently resume an old objective. Park a
   concise checkpoint only when substantial work needs to continue later. Start
   a distinct tracked record only if the new work benefits from continuity,
   dependencies, coordination, or durable decisions. For work spanning repos,
   checkpoint each unfinished item with its checkout, branch, requested
   deliverables, and delivery endpoint. Keep explicitly held items parked with
   their resume condition until the user resumes them. A conversational
   checkpoint is sufficient when no task record is needed.
4. Before resuming a named tracked task, reconcile its checkout, branch, dirty
   state, current policy, stale evidence, uncertain effects, and ownership. Do
   not change branches, stash, fetch large histories, or seize ownership just
   to display a history choice.
5. Continue to the user's authorized endpoint with applicable checks. Ask only
   about consequential choices the code and available context cannot resolve.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Treating a quick question as interruption | Answer without changing task state. |
| Auto-resuming an old objective | Wait for the user's direction to resume it. |
| Rebuilding continuity from a transcript | Keep a compact checkpoint with evidence and next action. |
