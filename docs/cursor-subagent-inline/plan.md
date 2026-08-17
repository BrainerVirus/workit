# Cursor Subagent-Driven + Inline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-subagent-inline/spec.md`
**Branch:** `feature/cursor-subagent-inline`

**Goal:** Enable subagent-driven plan execution on Cursor via a task-bound token, and make Cursor Inline truly single-agent, while keeping OpenCode's parentage model, CLI flow, and the coordinator boundary intact.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- TDD rails: write the failing test first, watch it fail, then write the minimal code to pass.
- Verification rail: no completion claim without running `bun run check` (or `workflow_verify`) and showing its output.
- Preserve existing comment style; the security rationale in `flow-evidence.ts` is intentionally documented — do not remove it.

---

### Task 1: Core token model + Cursor context derivation (TDD)

- [ ] **Step 1: Write failing tests.** In `test/workit-core/flow-state.test.ts` and `test/workit-cursor/flow-evidence.test.ts` (new), assert: (a) a `workit_delegate`-minted token binds to `(slug, taskId, workspaceRoot)` and is single-use; (b) `cursorMutationContext(workspace, { token })` returns `role: "delegated"` with `taskIdentity` when the token validates against the active task in the workspace, and `role: "coordinator"` otherwise; (c) `recordPlanMenuChoice` with Cursor evidence + `subagent-driven` no longer returns `unsupported_mode` and records `mode: "subagent-driven"`. Run focused tests and confirm they fail (RED).
- [ ] **Step 2: Implement the core token model.** In `packages/workit-core/src/core/flow-state.ts`, add a token store (bound `(slug, taskId, workspaceRoot)`, single-use consume) and a `validateDelegateToken` helper; remove the Cursor `unsupported_mode` rejection at line 1610 so Cursor can record `subagent-driven`; update `CURSOR_SUBAGENT_UNSUPPORTED_TEXT` to removal or repurpose. Add a `workit_delegate` mutation tool (core) that mints a token.
- [ ] **Step 3: Update `cursorMutationContext`.** In `packages/workit-cursor/mcp/flow-evidence.ts`, accept an optional token arg; when present and validated against the flow state, return `role: "delegated"` + `taskIdentity`; otherwise keep `role: "coordinator"`. Preserve the fail-closed behavior. Run focused tests and confirm GREEN.

**Criteria:** `bun test test/workit-core/flow-state.test.ts test/workit-cursor` pass after the change; RED observed before.

| Status | Task |
| --- | --- |
| pending | 1: Core token model + Cursor context derivation (TDD) |

---

### Task 2: Wire the Cursor MCP delegate tool + mutation token passing

- [ ] **Step 1: Write failing tests.** In `test/workit-cursor/mcp-process.test.ts` and `test/workit-cursor/mcp-regressions.test.ts`, assert the MCP exposes `workit_delegate` and that mutation tools accept a token and grant delegated identity when valid; assert invalid/consumed/wrong-task tokens are rejected with structured errors. Run and confirm RED.
- [ ] **Step 2: Register `workit_delegate` in the Cursor MCP server.** In `packages/workit-cursor/mcp/server.ts`, add a `workit_delegate` tool that mints a token bound to `(slug, taskId, workspaceRoot)`. Thread the token arg through the allowlisted mutation tools (`workit_sdd_task_brief`, `workit_sdd_append_progress`, `workit_sdd_review_package`, etc.) into `cursorMutationContext`.
- [ ] **Step 3: Confirm GREEN.** Run the focused `test/workit-cursor` and confirm they pass.

**Criteria:** `bun test test/workit-cursor` passes; `workit_delegate` and token-gated mutations work end-to-end in the MCP.

| Status | Task |
| --- | --- |
| pending | 2: Wire the Cursor MCP delegate tool + mutation token passing |

---

### Task 3: Fix Cursor Inline to be single-agent + update the menu/rule text

- [ ] **Step 1: Write failing tests.** In `test/workit-cursor/flow-enforcement.test.ts` and `test/workit-opencode/flow-enforcement.test.ts`, assert the post-plan menu / skill-routing contract distinguishes Subagent-driven (delegated) from Inline (single-agent) on Cursor; assert Inline routes to `executing-plans` and does not mint tokens. Run and confirm RED.
- [ ] **Step 2: Update the Cursor menu/rule + skill routing.** Update `packages/workit-cursor/rules/ask-question-only.mdc` (and any post-plan menu text) so Subagent-driven is now supported (token-based), Inline is single-agent (`executing-plans`), and Handoff is the pasteable prompt. Ensure the `wk-implement` skill (coordinator pattern) is used only for Subagent-driven, and Inline uses `executing-plans`.
- [ ] **Step 3: Confirm GREEN.** Run the focused enforcement tests and confirm they pass.

**Criteria:** `bun test test/workit-cursor/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts` pass; the Cursor menu text reflects supported subagent-driven + single-agent inline.

| Status | Task |
| --- | --- |
| pending | 3: Fix Cursor Inline to be single-agent + update the menu/rule text |

---

### Task 4: Docs, policy, changelog, full verification, and completion

- [ ] **Step 1: Update README/AGENTS/CHANGELOG.** Update root README, Cursor package README, and AGENTS.md to describe Cursor subagent-driven (token-based) and single-agent Inline; note the OpenCode parentage vs Cursor token host-adaptation difference. Add a CHANGELOG Unreleased entry.
- [ ] **Step 2: Run full verification.** Run `bun run check` (and `workflow_verify`) plus `bun run validate:cursor-marketplace`, confirming lint, format:check, tests, build, and changelog pass. Confirm a parity test proves OpenCode (parentage) and Cursor (token) both satisfy the shared core's delegated-worker contract.
- [ ] **Step 3: Complete the plan.** Confirm the SDD ledger is complete and repository verification passes, then call `workflow_plan_complete` (or `workit flow complete`). The plan must not remain `active`.

**Criteria:** `workflow_verify` / `bun run check` reports all gates pass (exit 0); plan transitions to `completed`.

| Status | Task |
| --- | --- |
| pending | 4: Docs, policy, changelog, full verification, and completion |
