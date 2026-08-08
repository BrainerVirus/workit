# Self-Review Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/self-review-enforcement/spec.md`
**Branch:** `feature/self-review-enforcement`

**Goal:** Hard quality gate in the first spec/plan transition — hard findings reject the self-review with actionable detail.

## Global Constraints

- Reuse `qualitySpec` + `parseTasksFromPlan` from `src/core/docs-validate.ts` verbatim (no new rule set).
- Gate ONLY the first transition (`draft → self_reviewed`); the second (`→ approved`) stays ungated.
- Warnings never block; only `severity === "hard"` findings reject.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: transitionSpec quality gate

- [ ] **Step 1:** In `src/core/flow-state.ts` `transitionSpec`: after the existence check and before `nextStatus` — when the current status is `draft` and `confirmed` is true (the first transition), read the spec text (resolve the path, readFileSync) and run `qualitySpec(text)`; collect findings with `severity === "hard"`; if any → `{ ok: false, error: "spec self-review failed: <codes/messages joined>" }` WITHOUT writing state (status stays draft). Import `qualitySpec` from `./docs-validate` (check for circular-import risk — docs-validate imports hygiene/scripts, not flow-state; verify).
- [ ] **Step 2:** Tests in `test/flow-state.test.ts` (or a new `test/self-review.test.ts`): (a) spec missing `## Acceptance criteria` → first transition rejected, flow.json still draft; (b) spec without CA-XX → rejected with missing_acceptance_criteria; (c) compliant spec → self_reviewed then approved; (d) only-warning spec (e.g. hygiene-style findings) → transitions fine.

**Criteria:** CA-01, CA-02, CA-03, CA-05.

| Status | Task |
| --- | --- |
| pending | 1: transitionSpec quality gate |

### Task 2: transitionPlan gate + superpowers ritual in the reminder

- [ ] **Step 1:** In `src/core/flow-state.ts` `transitionPlan`: when the current plan status is `draft` and `confirmed` is true — read the plan text; validate (a) `parseTasksFromPlan` returns ≥1 task, (b) the text contains `**Spec:**`, `**Branch:**`, and at least one `### Task N:` heading (outside fences — use the same stripFences approach qualitySpec uses, or reuse the plan-task scanner); failure → `{ ok: false, error: "plan self-review failed: <detail>" }` without writing (stays draft).
- [ ] **Step 2:** `src/core/reminder.ts` `REMINDER_TEXT`: add the superpowers self-review ritual line — before the first `workflow_spec_approve`/`workflow_plan_approve`, run the writing-plans Self-Review checklist: spec coverage (every requirement maps to a task), placeholder scan, type consistency; fix findings inline.
- [ ] **Step 3:** Tests: plan with no `### Task N:` → rejected; plan missing `**Spec:**` → rejected; compliant plan (with approved spec) → self_reviewed then approved; plan with only warning-ish issues → passes; reminder-text test asserts the ritual line (CA-06).

**Criteria:** CA-04, CA-06.

| Status | Task |
| --- | --- |
| pending | 1: transitionSpec quality gate |
| pending | 2: transitionPlan gate + superpowers ritual in the reminder |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (gate placement, circular imports, error detail, no regression on the second transition, warning tolerance).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/self-review-enforcement`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: transitionSpec quality gate |
| pending | 2: transitionPlan gate + superpowers ritual in the reminder |
| pending | 3: Final gate — review + PR |
