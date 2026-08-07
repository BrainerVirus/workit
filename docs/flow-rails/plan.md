# Flow Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/flow-rails/spec.md`
**Branch:** `feature/flow-rails`

**Goal:** Fix the wf-issue-update prompt anti-pattern and add a per-turn subagent-driven reminder rail.

## Global Constraints

- Follow existing code style in `src/core/` (bun + TypeScript, no comments unless asked).
- New reminder text lives in `src/core/reminder.ts` alongside `REMINDER_TEXT`/`DETECTION_TEXT`.
- Hook logic lives in `src/plugin.ts` inside `experimental.chat.messages.transform`, wrapped in the existing try/catch (never break the session).
- Tests follow the existing pattern in `test/` (bun:test, no frameworks).
- `bun run check` (test + typecheck) must stay green; CI gate is the same command.

---

### Task 1: Fix wf-issue-update prompt anti-pattern

- [ ] **Step 1:** Edit `skills/wf-issue-update/SKILL.md` step 2 to require asking for the issue URL/ID in plain prose (custom answer path), and add an explicit rule: never present a clickable option whose label is an instruction like "Type the issue URL/ID" — clicking an option returns the label literal, not free text.

**Criteria:** Skill text forbids instruction-labeled clickable options and requires plain-prose request; no other behavior changes.

| Status | Task |
| --- | --- |
| pending | 1: Fix wf-issue-update prompt anti-pattern |

### Task 2: Subagent-driven reminder rail

- [ ] **Step 1:** Add `SDD_REMINDER_TEXT` constant to `src/core/reminder.ts` (mirrors `REMINDER_TEXT` style; instructs: plan is subagent-driven → execute via `wf-implement`/`task`, never inline).
- [ ] **Step 2:** In `src/core/detector.ts` add `findActiveSubagentDrivenPlans(root: string): string[]` — scans `docs/*/sdd/flow.json` from the working directory, returns slugs where `menu.chosen === "subagent-driven"` and `plan.status` is `approved` (active execution).
- [ ] **Step 3:** In `src/plugin.ts` `chat.messages.transform`, after the existing doc-delivery detection, when `findActiveSubagentDrivenPlans(...)` returns slugs and the current user turn lacks `workflow-sdd-reminder`, unshift `SDD_REMINDER_TEXT` anchored to the current message (same `makePart` pattern).
- [ ] **Step 4:** Add tests in `test/plugin-reminder.test.ts` (or extend existing reminder test file): active plan → reminder injected; inactive/missing/malformed flow.json → no reminder, no throw; idempotency (text present in turn → not duplicated).

**Criteria:** New tests cover CA-02/CA-03/CA-04; `bun run check` green.

| Status | Task |
| --- | --- |
| pending | 1: Fix wf-issue-update prompt anti-pattern |
| pending | 2: Subagent-driven reminder rail |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (correctness of the rail, idempotency, skill wording).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/flow-rails`, create PR, wait for CI, merge, delete branch.

**Criteria:** Review findings addressed; CI pass; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: Fix wf-issue-update prompt anti-pattern |
| pending | 2: Subagent-driven reminder rail |
| pending | 3: Final gate — review + PR |
