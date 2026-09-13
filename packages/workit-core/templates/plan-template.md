# <Feature> Implementation Plan

> **For agentic workers:** Load `workit-implement` when policy selects implementation. Use bounded `workit_worker` delegation when the host supports it; otherwise execute inline within writer scope. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/<slug>/spec.md`
**Branch:** `feature/<slug>`

**Goal:** <one sentence>

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; record the real base..head shas in task progress.
- The final task closes the lead Workit task with `workit_task` `action: "close"` (CLI: `workit task close --payload … [--confirm]`) once requirements are satisfied and repository verification passes — never finish while the task is still `active` or `paused`.
- <project-wide requirements, one line each>

---

### Task N: <Component>

- [ ] **Step 1: <action>**

<!-- per-task criteria: how this task is verified -->
**Criteria:** <verifiable check>

| Status | Task |
| --- | --- |
| pending | N: <Component> |
