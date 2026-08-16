# Execution Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/execution-contract-repair/spec.md`
**Branch:** `feature/execution-contract-repair`

**Goal:** Repair the execution contract in three phases — mandated plan completion, atomic per-task commit ranges with empty-range guards, and user-facing `workit` naming — shipped in one PR with phase-scoped commits.

## Global Constraints

- No production code without a failing test first (TDD rail).
- Core logic lives in `packages/workit-core/src/core/`; adapters map host-native surfaces only.
- Parity: identical outcomes through core, OpenCode tool wrapper, Cursor MCP, and CLI surfaces.
- No worktrees; in-place branch `feature/execution-contract-repair` (already created).
- Legacy-identity detection and migration code is byte-identical — only user-facing names change.
- Docs, AGENTS.md, and CHANGELOG Unreleased updated in the same change (parity rule 3).
- Cursor Marketplace pin `@brainervirus/workit-cursor@0.8.0` is never weakened.
- Each task lands one contiguous non-empty commit range; fix rounds append commits; never rewrite an active review range (this plan follows the very rule it codifies).

---

### Task 1: Failing tests for empty-range rejection (Phase 2 groundwork)

- [ ] **Step 1:** Add failing tests in `test/workit-core/sdd.test.ts`: `sddReviewPackage` with `base_sha === head_sha` returns a structured error (no empty diff file); the progress-line validator rejects `Task N: complete (commits <same>..<same>, ...)`.
- [ ] **Step 2:** Add a failing parity test through the OpenCode SDD tool wrapper proving the same rejection.
- [ ] **Step 3:** Add a failing test that a real `base..head` range still produces the diff (guard stays green-path correct).

**Criteria:** New tests fail before the fix and pass after; existing review-package tests unchanged.

| Status | Task |
| --- | --- |
| pending | 1: Failing tests for empty-range rejection |

### Task 2: Enforce empty-range guards (Phase 2)

- [ ] **Step 1:** In `packages/workit-core/src/core/sdd.ts`, make `sddReviewPackage` reject `base_sha === head_sha` (or a diff that is empty) with a structured error naming the task range; tighten `PROGRESS_RE` to reject identical shas.
- [ ] **Step 2:** Surface the same guard through the Cursor MCP and CLI port wrappers (parity) with adapter-level tests.
- [ ] **Step 3:** Run the focused suites (`sdd.test.ts`, cursor mcp-regressions, packed-cli) and confirm green.

**Criteria:** Task 1 tests pass; no adapter re-implements the guard; full suite green.

| Status | Task |
| --- | --- |
| pending | 2: Enforce empty-range guards |

### Task 3: Codify atomic per-task commit ranges in templates and skills (Phase 2)

- [ ] **Step 1:** Update `packages/workit-core/templates/plan-template.md` (and any adapter copies) to require one contiguous non-empty commit range per task, with fix rounds appending commits and no rewriting of an active review range; remove the "do not create per-task commits" wording.
- [ ] **Step 2:** Update `wk-implement/SKILL.md` and the subagent-driven-development skill text to state the per-task commit-range rule and that each progress line records the task's real `base..head` shas.
- [ ] **Step 3:** Add a contract test asserting the template and skill contain the per-task commit-range rule (mirroring the existing contract tests over skill text).

**Criteria:** Template/skill text and SDD machinery agree; contract test passes; no stale "no per-task commits" wording remains.

| Status | Task |
| --- | --- |
| pending | 3: Codify atomic per-task commit ranges in templates and skills |

### Task 4: Mandate plan completion in the execution contract (Phase 1)

- [ ] **Step 1:** Add a failing contract test asserting wk-implement, wk-handoff, and subagent-driven skill text require ending execution with `workflow_plan_complete` (or CLI equivalent) after the final task once the ledger is complete and verification passes.
- [ ] **Step 2:** Update the skill texts (and the plan template's final-task guidance) to mandate the completion step, including the exact tool name and its precondition (complete ledger + green verification).
- [ ] **Step 3:** Add a completion-contract test in `test/workit-core/` (or the opencode flow suite) proving a run that finishes tasks without `workflow_plan_complete` leaves the plan `active`, and that calling the tool completes it.

**Criteria:** Contract test passes; skill text mandates completion; the flow test proves active -> completed via the tool.

| Status | Task |
| --- | --- |
| pending | 4: Mandate plan completion in the execution contract |

### Task 5: Rename user-facing surfaces to workit (Phase 3)

- [ ] **Step 1:** Grep inventory (with tests): user-facing `workflow-toolkit`/`workflow`/`flowkit` occurrences — bootstrap contract marker (`<workflow-toolkit-contract>`), `workflow_toolkit_status`/`workflow_toolkit_init_status` tool names, YouTrack token default name `flowkit`, share path `~/.local/share/workflow-toolkit`, `.workflow-toolkit-root` marker, plugin.ts/bootstrap.ts strings, skill text mentions.
- [ ] **Step 2:** Rename the user-facing identifiers to `workit` equivalents (e.g. `<workit-contract>` marker, `workit_status`/`workit_init_status`, token default `workit`, `~/.local/share/workit`, `.workit-root`), updating every caller and test in the same commit range.
- [ ] **Step 3:** Keep legacy-identity detection and migration code byte-identical; run the doctor/migration/config-dir suites to prove cleanup still works.

**Criteria:** No user-facing `workflow-toolkit`/`flowkit` remains (grep clean on user-facing surfaces); legacy detection tests pass unchanged; parity tests green.

| Status | Task |
| --- | --- |
| pending | 5: Rename user-facing surfaces to workit |

### Task 6: Documentation, changelog, and full verification (all phases)

- [ ] **Step 1:** Update README, AGENTS.md, and CHANGELOG.md Unreleased: completion step in the execution contract, atomic per-task commit ranges, empty-range rejection, and the naming change.
- [ ] **Step 2:** Run `workflow_verify` (lint, format:check, tests, build, changelog) and fix any failures introduced by this feature.
- [ ] **Step 3:** Re-run the focused suites (sdd, flow-enforcement, contracts, doctor, migration, packed-cli, cursor flow) and confirm all pass; run the completion-contract test end-to-end (finish a task run and complete the plan).

**Criteria:** `workflow_verify` passes; docs/changelog reflect all three phases; the completion-contract test proves a real plan run reaches `completed`.

| Status | Task |
| --- | --- |
| pending | 6: Documentation, changelog, and full verification |
