# Cursor Subagent-Driven + Inline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-subagent-inline/spec.md`
**Branch:** `feature/cursor-subagent-inline`

**Goal:** Enable Cursor subagent-driven execution through a lease/token capability protocol and make Cursor Inline single-agent.

**Architecture:** Core persists only hashes for a coordinator lease and one active task token. The Cursor adapter validates the token before producing delegated mutation context; OpenCode keeps parentID-derived context and the CLI remains unchanged. Cursor's execution skill dispatches native subagents only for Subagent-driven and uses `executing-plans` for Inline.

**Tech Stack:** TypeScript/Bun, JSON flow state under `docs/<slug>/sdd/flow.json`, Cursor MCP tool registration, Markdown skills/templates, Vitest-compatible Bun tests.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workit_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- TDD rail: write the failing test first, run it and observe failure, then write the minimum production change and run the focused test again.
- Cursor tokens are opaque capabilities: use cryptographically random values, persist only SHA-256 hashes, never log raw values, and fail closed on validation errors.
- Cursor Handoff remains the existing pasteable prompt and is not modified.

---

### Task 1: Core lease and task-token model

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Test: `test/workit-core/flow-state.test.ts`

**Interfaces:**
- Produces `CoordinatorLease`, `DelegateTokenRecord`, `mintCoordinatorLease`, `mintDelegateToken`, `validateDelegateToken`, and `revokeDelegateToken` behavior owned by flow state.
- `mintDelegateToken(root, slug, planPath, taskId, coordinatorLease)` returns `{ ok: true, token: string }` or a structured error; persisted state stores only hashes.

- [ ] **Step 1: Write failing tests.** Add tests for `recordMenuChoice` with Cursor evidence and `subagent-driven`, coordinator-lease issuance, lease reuse rejection, token binding to `(workspaceRoot, slug, taskId)`, task-scoped reuse, revocation at task progress, and invalid/wrong-task/wrong-workspace rejection.
- [ ] **Step 2: Run the focused tests.** Run `bun test test/workit-core/flow-state.test.ts` and confirm the new tests fail because Cursor still returns `unsupported_mode` and no delegation state exists.
- [ ] **Step 3: Implement the minimal core model.** Add validated delegation fields to `FlowState`: coordinator lease hash, active task id, token hash, token slug/workspace, and token status. Generate raw values with `crypto.randomBytes`, persist only SHA-256 hashes through the existing atomic flow-state writer, return the raw lease once from `recordMenuChoice`, and make `mintDelegateToken` require an active Cursor subagent-driven flow, an approved plan, an unfinished task id, and the lease hash. Remove the Cursor rejection from `recordMenuChoice`; return structured failures instead of fallback coordinator context.
- [ ] **Step 4: Run the focused tests.** Run `bun test test/workit-core/flow-state.test.ts`; expected result is PASS for lease issuance, task-token validation, reuse, revocation, and fail-closed errors.
- [ ] **Step 5: Commit the task.** Commit the core lease/token model and tests as one non-empty task range.

**Criteria:** The core tests pass; raw secrets do not appear in serialized `flow.json`; Cursor can enter subagent-driven mode only through the tested lease path.

| Status | Task |
| --- | --- |
| pending | 1: Core lease and task-token model |

---

### Task 2: Cursor MCP delegation tool and token-gated mutations

**Files:**
- Modify: `packages/workit-cursor/mcp/flow-evidence.ts`
- Modify: `packages/workit-cursor/mcp/server.ts`
- Test: `test/workit-cursor/flow-evidence.test.ts`
- Test: `test/workit-cursor/mcp-process.test.ts`
- Test: `test/workit-cursor/mcp-regressions.test.ts`

**Interfaces:**
- `cursorMutationContext(workspaceRoot, delegationToken?)` returns `{ ok: true, context: MutationContext }` or `{ ok: false, code, error }`; invalid supplied tokens never return coordinator context.
- The MCP exposes `workit_delegate({ slug, plan_path, task_id, coordinator_lease, workspace_root })` and mutation tools accept `delegation_token` without accepting caller-supplied `role` or `taskIdentity`.

- [ ] **Step 1: Write failing tests.** Assert the MCP exposes `workit_delegate`, valid token-gated SDD mutations receive delegated context, missing tokens preserve coordinator behavior only where coordinator mutations are allowed, and invalid/revoked/wrong-task/wrong-workspace tokens return structured errors. Add a concurrency test for token mint/revoke writes.
- [ ] **Step 2: Run the focused tests.** Run `bun test test/workit-cursor/flow-evidence.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/mcp-regressions.test.ts` and confirm the new assertions fail against the current coordinator-only adapter.
- [ ] **Step 3: Implement the MCP adapter.** Change `cursorMutationContext` to validate an optional token through the core helper and return a failure result instead of downgrading an invalid token. Register `workit_delegate` with the exact schema above. Thread `delegation_token` through every Cursor mutation wrapper covered by the core mutation allowlist: `workit_sdd_task_brief`, `workit_sdd_review_package`, `workit_sdd_append_progress`, `workit_docs_promote`, `workit_docs_layout`, `workit_docs_repo_link`, `workit_rule_edit`, `workit_template_edit`, `workit_changelog_apply`, `workit_branch_setup`, `workit_pr_create`, `workit_youtrack_post`, and `workit_youtrack_log_time`.
- [ ] **Step 4: Run the focused tests.** Re-run the three Cursor test files and confirm valid delegation works while invalid tokens fail closed.
- [ ] **Step 5: Commit the task.** Commit the Cursor MCP delegation wiring and tests as one non-empty task range.

**Criteria:** Cursor MCP exposes the delegation tool, all listed mutation wrappers pass validated context, raw tokens are absent from logs/state, and focused tests pass.

| Status | Task |
| --- | --- |
| pending | 2: Cursor MCP delegation tool and token-gated mutations |

---

### Task 3: Cursor execution-mode routing and shipped contracts

**Files:**
- Modify: `packages/workit-cursor/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-cursor/rules/ask-question-only.mdc`
- Modify: `packages/workit-cursor/assets/templates/execution-contract.md`
- Modify: `packages/workit-cursor/assets/templates/superpowers-doc-contract.md`
- Modify: `packages/workit-cursor/assets/templates/plan-template.md`
- Modify: `packages/workit-cursor/vendor/superpowers/skills/executing-plans/SKILL.md`
- Modify: `packages/workit-cursor/README.md`
- Test: `test/workit-cursor/flow-enforcement.test.ts`

**Interfaces:**
- Cursor `wk-implement` reads the approved execution mode: `subagent-driven` dispatches Cursor-native subagents and includes a task token; `inline` follows `executing-plans` directly in the current session.
- The Cursor rules and shipped templates describe the same two paths; they do not call OpenCode's `task` or claim Cursor has `parentID` session identity.

- [ ] **Step 1: Write failing tests.** Extend `test/workit-cursor/flow-enforcement.test.ts` to assert the shipped Cursor skill/rule/template text contains the supported Subagent-driven/token path, the single-agent Inline path, and no `subagent-driven is unsupported` contract. Assert Inline does not mention token minting or native subagent dispatch.
- [ ] **Step 2: Run the focused test.** Run `bun test test/workit-cursor/flow-enforcement.test.ts` and confirm it fails against the current unsupported/inline-only copy.
- [ ] **Step 3: Update the Cursor execution contract.** Make `wk-implement` mode-aware: for Subagent-driven, obtain the coordinator lease, mint one task token per task, dispatch the Cursor-native subagent with the token, and keep coordinator product edits blocked; for Inline, load/follow `executing-plans` and do every task in the current agent without dispatch or token minting. Update rules, execution/doc contracts, plan template, vendor executing-plans guidance, and README consistently. Leave Handoff's pasteable-prompt instructions unchanged.
- [ ] **Step 4: Run the focused test.** Re-run `bun test test/workit-cursor/flow-enforcement.test.ts` and confirm PASS.
- [ ] **Step 5: Commit the task.** Commit the Cursor execution routing and shipped contract updates as one non-empty task range.

**Criteria:** Cursor's installed skill/rule/template surfaces distinguish the two execution modes correctly; Inline is explicitly single-agent; Subagent-driven explicitly uses Cursor-native subagents plus task tokens.

| Status | Task |
| --- | --- |
| pending | 3: Cursor execution-mode routing and shipped contracts |

---

### Task 4: Host parity, docs, verification, and completion

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Test: `test/workit-opencode/flow-enforcement.test.ts`
- Test: `test/workit-cli/flow-parity.test.ts`
- Test: `test/workit-cursor/flow-enforcement.test.ts`

**Interfaces:**
- OpenCode continues to derive delegated context from `parentID`; Cursor derives it from a validated lease/token; CLI behavior remains unchanged. Tests assert these host-specific contracts rather than forcing identical mechanics.

- [ ] **Step 1: Write failing parity tests.** Add assertions that OpenCode still uses parentage, Cursor uses token context, CLI preserves its existing execution-mode behavior, and Cursor Handoff remains the existing prompt path. Run the three focused parity files and confirm the new assertions fail before docs/contract updates.
- [ ] **Step 2: Update documentation.** Update root README, `AGENTS.md`, Cursor README, and CHANGELOG Unreleased to describe the host-specific execution model and the fail-closed lease/token capability; remove the stale claim that Cursor subagent-driven is unsupported, but do not claim Cursor has OpenCode parentID authentication or change Handoff wording.
- [ ] **Step 3: Run focused parity tests.** Run `bun test test/workit-opencode/flow-enforcement.test.ts test/workit-cli/flow-parity.test.ts test/workit-cursor/flow-enforcement.test.ts` and confirm PASS.
- [ ] **Step 4: Run full verification.** Run `bun run check`, `bun run validate:cursor-marketplace`, and the repository verification command; expected result is exit 0 for lint, format, tests, build, changelog, and Marketplace validation.
- [ ] **Step 5: Complete the SDD ledger and plan.** Call `workit_sdd_append_progress` for task IDs 1-4 with each task's real non-empty commit range, then call `workit_plan_complete` only after verification passes.
- [ ] **Step 6: Commit the task.** Commit the parity tests, docs, and final verification updates as one non-empty task range.

**Criteria:** All host-parity tests pass; Handoff is unchanged; full verification is green; every task has a ledger range; the plan is `completed`, not `active`.

| Status | Task |
| --- | --- |
| pending | 4: Host parity, docs, verification, and completion |
