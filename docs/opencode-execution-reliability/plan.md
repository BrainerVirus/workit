# OpenCode Execution Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/opencode-execution-reliability/spec.md`
**Branch:** `bugfix/opencode-execution-reliability`

**Goal:** Make OpenCode execution-menu, handoff, SDD coordination, and delegated-worker flows start cleanly and enforce one authenticated direct-child lineage.

**Architecture:** The shared core gains purpose-bound receipts, coordinator-owned SDD control gates, advisory persistence, and a persisted activating-coordinator ID. OpenCode classifies native questions, preflights handoff before session creation, and derives direct-child authority from host session records; Cursor and CLI consume the same core outcomes through host-native surfaces.

**Tech Stack:** TypeScript 5.8, Bun tests, OpenCode plugin SDK, Cursor MCP SDK, Node standard library, Markdown skills/contracts.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes; a run never finishes while the plan is still `active`.
- Follow TDD in every task: write the focused failing check, observe RED, implement the minimum change, then observe GREEN.
- Keep all shared behavior in `packages/workit-core/src/core/`; adapters only map host-native evidence, tools, sessions, and UI.
- Preserve approval digests, freshness, one-use receipt consumption, negative-answer rejection, Cursor policy-only evidence, and CLI confirmation semantics.
- `Change model first` is display-only deferral and never enters `MENU_CHOICES`, `ExecutionMode`, or persisted `menu.chosen`.
- Coordinator SDD permissions apply only to validated gitignored `docs/<slug>/sdd/` control artifacts; tracked product and external mutations remain blocked.
- Never trust caller-supplied role, parent, session, task, receipt, or confirmation identity.
- Never use worktrees or add a new runtime dependency.

---

### Task 1: Purpose-bound receipts and model-deferral menus

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Modify: `packages/workit-core/src/core/menu.ts`
- Modify: `packages/workit-core/src/core/reminder.ts`
- Modify: `packages/workit-opencode/src/plugin.ts`
- Modify: `packages/workit-opencode/src/tools/flow.ts`
- Modify: `packages/workit-opencode/src/bootstrap.ts`
- Modify: `packages/workit-core/templates/superpowers-doc-contract.md`
- Modify: `packages/workit-core/templates/execution-contract.md`
- Modify: `packages/workit-opencode/assets/templates/superpowers-doc-contract.md`
- Modify: `packages/workit-opencode/assets/templates/execution-contract.md`
- Modify: `packages/workit-cursor/assets/templates/superpowers-doc-contract.md`
- Modify: `packages/workit-cursor/assets/templates/execution-contract.md`
- Modify: `packages/workit-cli/assets/templates/superpowers-doc-contract.md`
- Modify: `packages/workit-cli/assets/templates/execution-contract.md`
- Test: `test/workit-core/flow-enforcement.test.ts`
- Test: `test/workit-core/handoff.test.ts`
- Test: `test/workit-opencode/flow-enforcement.test.ts`
- Test: `test/workit-opencode/plugin-reminder.test.ts`
- Test: `test/workit-opencode/bootstrap.test.ts`
- Test: `test/workit-cursor/flow-enforcement.test.ts`
- Test: `test/workit-cursor/session-start.test.ts`
- Test: `test/workit-cli/flow-parity.test.ts`

**Interfaces:**
- Produces: `ReceiptPurpose = "spec-approval" | "plan-approval" | "execution-menu" | "plan-pause" | "plan-resume" | "plan-complete"`.
- Produces: `HostReceipt` with required `sessionId`, `callID`, `selectedLabel`, `recordedAt`, `question`, and `purpose`; `HostReceiptStore.consume(sessionId, { purpose, label? })` selects by purpose.
- Produces: `receiptPurposeForLabel(label): ReceiptPurpose | undefined`; exact semantic base labels map as follows: `Approve spec` -> `spec-approval`, `Approve plan` -> `plan-approval`, all source/destination menu labels including `Change model first` -> `execution-menu`, and `Pause plan`/`Resume plan`/`Complete plan` -> their matching lifecycle purpose. Unknown and near-miss labels return `undefined`.
- Preserves: `MENU_CHOICES` and `ExecutionMode`; model deferral exists only in `SOURCE_MENU_LABELS` and `DESTINATION_MENU_LABELS`.
- Consumes: OpenCode's observed native-question input and result; unclassified questions are not recorded in `HostReceiptStore`.

- [ ] **Step 1: Add failing receipt-correlation tests.** Cover all six purpose mappings, decorated menu labels, unknown/near-miss labels, an execution-menu answer followed by an unrelated `Proceed` question, newest same-purpose negative rejection, exact-purpose one-use/freshness behavior, unchanged anti-fabrication label checks, and preservation of original question/session/call/label/timestamp bytes. Update test receipt helpers to pass an explicit purpose. Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts`; expected result is FAIL because receipts have no purpose and the latest unrelated answer wins.
- [ ] **Step 2: Implement purpose-bound receipts.** Add the `ReceiptPurpose` union and required `purpose` field in `flow-state.ts`; make `HostReceiptStore` search backward for the newest same-purpose receipt, revoke only older receipts of that purpose after a same-purpose negative answer, and leave unrelated purpose queues untouched. Update each OpenCode approval/menu/lifecycle tool to consume its exact purpose.
- [ ] **Step 3: Classify observed OpenCode questions.** In `plugin.ts`, accept only a single answered single-select question, derive purpose from the exact observed selected label through `receiptPurposeForLabel`, parse `questions[0].question` for audit evidence, and record nothing for branch, stash, free-text, multi-question, multi-select, unknown, or near-miss answers. Preserve original question and selected-label bytes in evidence. Re-run the Step 1 command; expected result is PASS.
- [ ] **Step 4: Add failing menu-contract tests.** Assert the source labels are exactly the existing five plus `Change model first`, destination labels are exactly the existing four plus `Change model first`, `change-model` remains an invalid persisted menu enum, a model-deferral answer cannot authorize any real menu choice, source/destination flow state stays pending and unchosen, the matching reminder is present again on the next turn, and Cursor Subagent-driven still returns `unsupported_mode` with a pending flow. Run `bun test test/workit-core/handoff.test.ts test/workit-opencode/plugin-reminder.test.ts test/workit-opencode/bootstrap.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-cursor/session-start.test.ts test/workit-cli/flow-parity.test.ts`; expected result is FAIL on label counts and contract text.
- [ ] **Step 5: Implement model deferral and immediate recording guidance.** Add the display label to the shared source/destination label tuples and synchronize canonical OpenCode/Cursor/CLI contracts. State that `Change model first` ends the turn without `workflow_plan_menu` and re-presents the appropriate menu next turn; real choices call `workflow_plan_menu` immediately before any skill, branch question, mutation, or handoff. Keep CLI lifecycle commands unchanged. Re-run the Step 4 command; expected result is PASS.
- [ ] **Step 6: Commit the task.** Use the approved `wk-commit` flow to create one non-empty commit with message `fix(flow): bind receipts to workflow purpose` containing only Task 1 files.

**Criteria:** CA-01 through CA-05 pass; unrelated questions cannot mask menu evidence; six source labels and five destination labels render without adding a persisted execution mode.

| Status | Task |
| --- | --- |
| pending | 1: Purpose-bound receipts and model-deferral menus |

---

### Task 2: Handoff preflight and automatic selection

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Modify: `packages/workit-core/src/core/handoff-tools.ts`
- Modify: `packages/workit-opencode/src/tools/handoff.ts`
- Modify: `packages/workit-opencode/assets/skills/wk-handoff/SKILL.md`
- Modify: `packages/workit-core/skills/wk-handoff/SKILL.md`
- Test: `test/workit-core/handoff.test.ts`

**Interfaces:**
- Produces: `assertHandoffReady(root, planPath): FlowGateResult`, requiring approved docs, `menu.presented === true`, `menu.chosen === "handoff"`, and `handoff_destination === false`.
- Preserves: `handoffSession()` stage result shape and create -> seed -> mark -> select ordering.
- Produces: handoff title `Workit: <slug>` and guidance identifying OpenCode's native `Continue opencode -s <session-id>` epilogue as the manual recovery path only for a selection-stage partial failure.

- [ ] **Step 1: Add failing preflight and title tests.** Assert missing/unrecorded/non-handoff/recursive menu states return a structured error before `session.create`, with create/seed/mark/select call counts all zero. Assert a valid non-`--stay` call publishes selection and uses `Workit: x`, not `Continue x`. Run `bun test test/workit-core/handoff.test.ts`; expected result is FAIL because the adapter currently creates before discovering missing handoff evidence and titles sessions `Continue <slug>`.
- [ ] **Step 2: Implement shared handoff readiness.** Add `assertHandoffReady` in `flow-state.ts` using effective reconciled state. Call it in the OpenCode handoff adapter before `handoffSession`; retain the current post-seed destination mark and idempotent selection retry behavior for genuine host-stage failures.
- [ ] **Step 3: Update selection and recovery guidance.** Change the title to `Workit: <slug>`. Keep successful non-`--stay` output dependent on a true TUI selection response; keep `stage: "select"`, the created session ID, and the native `Continue opencode -s <id>` epilogue as manual recovery on unavailable/failed host selection. Update both canonical and OpenCode `wk-handoff` copies to treat that exact phrase as recovery, not a Workit-generated bug.
- [ ] **Step 4: Confirm GREEN and regressions.** Run `bun test test/workit-core/handoff.test.ts test/workit-opencode/plugin.test.ts`; expected result is PASS with existing create/seed/mark/select partial-failure coverage unchanged.
- [ ] **Step 5: Commit the task.** Use the approved `wk-commit` flow to create one non-empty commit with message `fix(handoff): validate before creating sessions` containing only Task 2 files.

**Criteria:** CA-06 through CA-09 pass; logical failures create no session, host failures preserve stage/session facts, and successful handoff selects automatically.

| Status | Task |
| --- | --- |
| pending | 2: Handoff preflight and automatic selection |

---

### Task 3: Coordinator-owned SDD control metadata

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Modify: `packages/workit-core/src/core/sdd.ts`
- Modify: `packages/workit-opencode/src/tools/sdd.ts`
- Modify: `packages/workit-cursor/mcp/server.ts`
- Modify: `packages/workit-cli/src/flow.ts`
- Modify: `packages/workit-cli/src/index.tsx`
- Modify: `packages/workit-core/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-opencode/assets/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-cursor/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-core/templates/execution-contract.md`
- Modify: `packages/workit-opencode/assets/templates/execution-contract.md`
- Modify: `packages/workit-cursor/assets/templates/execution-contract.md`
- Modify: `packages/workit-cli/assets/templates/execution-contract.md`
- Test: `test/workit-core/sdd.test.ts`
- Test: `test/workit-core/flow-enforcement.test.ts`
- Test: `test/workit-opencode/flow-enforcement.test.ts`
- Test: `test/workit-opencode/plugin.test.ts`
- Test: `test/workit-cursor/flow-enforcement.test.ts`
- Test: `test/workit-cli/flow-parity.test.ts`

**Interfaces:**
- Produces: `assertSddControlGates(root, slug, opts, ctx)`; coordinator-only for active subagent-driven control metadata, while retaining workspace, approval, menu, docs, and path gates.
- Produces: `sddAppendAdvisory({ advisories_path, task_id, text, workspace_root })` returning `{ ok: true, advisory, advisories_path }` or a structured `{ error, code }`. `task_id` is a positive safe integer; text is 1-1000 characters after trim and horizontal-space collapse, rejects CR/LF, and appends exactly `- Task N: <text>\n` to canonical `advisories.md`.
- Produces: OpenCode/Cursor tool `workflow_sdd_append_advisory` and CLI `workit flow append-advisory --plan <path> --task <id> --text <text> [--confirm]`.
- Preserves: product mutation gating through `assertProductGates`; no unrestricted coordinator file-write permission.

- [ ] **Step 1: Add failing ownership tests.** Establish an active subagent-driven flow and assert the root coordinator can call task-brief, review-package, progress, and advisory operations, while root `write`, `apply_patch`, product commit, `workflow_branch_setup`, `workflow_template_edit`, `workit_init_apply`, `workflow_youtrack_post`, and disallowed shell calls still fail. Assert a delegated worker cannot mutate coordinator control metadata. Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts`; expected result is FAIL because all SDD tools currently pass through the product boundary.
- [ ] **Step 2: Implement the SDD control boundary.** Add `assertSddControlGates` as a shared core path that reuses effective flow/docs/workspace checks but requires the coordinator for active subagent-driven control writes. Route existing task-brief, review-package, and progress adapters through it; remove those exact tools from `COORDINATOR_WRITE_TOOLS`; keep all product and external tools in the denied set. Update recovery text so it delegates product work, not coordinator bookkeeping.
- [ ] **Step 3: Add failing advisory parity tests.** Assert task IDs `0`, negative, fractional, unsafe, and non-numeric values fail with `advisory_task_invalid`; empty/over-1000/CR/LF text fails with `advisory_text_invalid`; noncanonical paths fail with `advisory_path_invalid`; directory targets fail with `advisory_target_invalid`; all failures write nothing. Assert tabs/repeated spaces normalize to one space and a valid advisory appends exactly `- Task N: <normalized text>`. Assert each adapter preserves the same core payload/code inside its host-native wrapper and the CLI preserves confirmation/exit semantics. Run `bun test test/workit-core/sdd.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-cli/flow-parity.test.ts`; expected result is FAIL because no advisory operation exists.
- [ ] **Step 4: Implement advisory persistence and adapters.** Add the path- and content-gated core append function, OpenCode tool, Cursor MCP registration, and CLI action. Limit advisory text to one normalized non-empty line and the exact canonical filename; use standard-library append only after all checks pass. Update `wk-implement` and execution-contract copies to call the dedicated operation instead of an unrestricted file edit.
- [ ] **Step 5: Confirm GREEN.** Run all Task 3 focused tests; expected result is PASS, with coordinator control writes allowed and tracked product writes still denied.
- [ ] **Step 6: Commit the task.** Use the approved `wk-commit` flow to create one non-empty commit with message `fix(sdd): keep control metadata with coordinator` containing only Task 3 files.

**Criteria:** CA-10 and CA-11 pass through core, OpenCode, Cursor, and CLI; advisory persistence adds no general write escape.

| Status | Task |
| --- | --- |
| pending | 3: Coordinator-owned SDD control metadata |

---

### Task 4: Direct-child delegation and worker-only context

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Modify: `packages/workit-core/src/core/detector.ts`
- Modify: `packages/workit-core/src/core/reminder.ts`
- Modify: `packages/workit-opencode/src/plugin.ts`
- Modify: `packages/workit-opencode/src/tools/flow.ts`
- Modify: `packages/workit-opencode/src/tools/sdd.ts`
- Modify: `packages/workit-core/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-opencode/assets/skills/wk-implement/SKILL.md`
- Modify: `packages/workit-core/templates/execution-contract.md`
- Modify: `packages/workit-opencode/assets/templates/execution-contract.md`
- Test: `test/workit-core/flow-enforcement.test.ts`
- Test: `test/workit-core/flow-concurrency.test.ts`
- Test: `test/workit-opencode/flow-enforcement.test.ts`
- Test: `test/workit-opencode/plugin.test.ts`
- Test: `test/workit-opencode/plugin-reminder.test.ts`

**Interfaces:**
- Extends: `FlowExecutionState` with `coordinator_session_id: string | null` and `MutationContext` with `parentSessionId?: string`.
- Changes: `roleFromParentage(parentID, coordinatorSessionID)` grants `delegated` only for an exact non-empty match; missing/mismatched identity is coordinator/fail-closed.
- Produces: `findActiveSubagentDrivenContexts(root): Array<{ slug: string; coordinator_session_id: string | null }>` for plugin interception.
- Changes: `subagentDrivenInterception` receives all active coordinator IDs. A worker is authorized only when the set contains exactly one non-null ID equal to its direct `parentID`; zero, null, mismatched, or multiple distinct owners deny with `delegation_lineage_denied`.
- Produces: `SDD_WORKER_REMINDER_TEXT`, injected only into an authorized direct child; coordinator sessions retain `SDD_REMINDER_TEXT`.

- [ ] **Step 1: Add failing state-lifecycle tests.** Assert OpenCode subagent activation records the current root session ID, pause/resume preserves it, completion and approval drift clear it, non-subagent choices leave it null, legacy state without the field normalizes to null, and a valid activation after drift reset plus a handoff destination activation records the new coordinator ID. Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts`; expected result is FAIL because flow state stores no coordinator session.
- [ ] **Step 2: Implement persisted coordinator identity.** Extend state parsing/defaults/transitions and pass host mutation context into menu recording. Store `ctx.sessionId` only for accepted OpenCode `subagent-driven`; preserve it only while that execution can resume; clear it on terminal/reset paths. Cursor's rejected subagent choice and CLI/inline states keep null.
- [ ] **Step 3: Add failing adversarial lineage tests.** Cover the observed chain `authorized child -> opencode run -> unrelated root -> task child`, a mismatched child, lookup failure, direct worker `bash` commands containing an `opencode` executable token, two active plans owned by different coordinators, and two active plans owned by the same coordinator. Assert only the direct child of the single effective recorded coordinator can perform host-native/product writes; mixed owners fail closed and nested launch is denied before execution. Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts`; expected result is FAIL because any non-empty `parentID` is currently trusted.
- [ ] **Step 4: Enforce direct lineage and nested-launch denial.** Return `parentSessionId` from `opencodeMutationContext`, compare it to persisted `coordinator_session_id` in product gates and plugin interception, and deny nested OpenCode executable tokens during active delegated work. Keep root coordinator product restrictions and inactive-plan behavior unchanged.
- [ ] **Step 5: Add failing worker-context contract tests.** Assert authorized children receive worker-only guidance with the supplied brief/TDD/commit/report duties and no `wk-implement`, `.superpowers/sdd`, worktree, nonexistent script, coordinator ledger, or nested-harness instruction. Assert the coordinator still receives the coordinator reminder. Run `bun test test/workit-opencode/plugin-reminder.test.ts test/workit-opencode/plugin.test.ts`; expected result is FAIL because every active session receives coordinator guidance and the full bootstrap.
- [ ] **Step 6: Implement worker-only context and literal clean-start coverage.** Resolve host parentage before first-turn bootstrap/reminder injection; authorized workers receive only the compact worker contract, while coordinators retain the normal contract. Add a literal contract test for menu record -> branch setup -> coordinator brief -> direct worker -> coordinator review/progress with no expected error result.
- [ ] **Step 7: Confirm GREEN.** Run all Task 4 focused tests; expected result is PASS, including the laundering reproduction and clean-start contract.
- [ ] **Step 8: Commit the task.** Use the approved `wk-commit` flow to create one non-empty commit with message `fix(opencode): bind workers to activating session` containing only Task 4 files.

**Criteria:** CA-12 through CA-17 pass; direct workers work, unrelated descendants fail closed, nested OpenCode is blocked, and child guidance never asks the child to coordinate.

| Status | Task |
| --- | --- |
| pending | 4: Direct-child delegation and worker-only context |

---

### Task 5: Host parity, documentation, and full verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `packages/workit-opencode/README.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `packages/workit-cli/README.md`
- Modify: `test/workit-core/contracts.test.ts`
- Create: `test/workit-core/execution-reliability-parity.test.ts`
- Modify: `test/workit-cursor/runtime-parity.test.ts`
- Modify: `test/workit-cli/scaffold-parity.test.ts`
- Verify: all files changed by Tasks 1-4

**Interfaces:**
- Consumes: all Task 1-4 public types, tools, menu labels, state fields, errors, and contract text.
- Produces: synchronized host assets, README/AGENTS behavior contract, and one Unreleased changelog entry.

- [ ] **Step 1: Add failing parity/contract assertions.** Require canonical template copies and host assets to agree on six source labels, five destination labels, immediate menu recording, model deferral, coordinator SDD ownership, direct-child authority, worker context, and the native `Continue opencode -s <session-id>` recovery phrase. In the new parity test, drive a table of core/OpenCode/Cursor/CLI-supported transitions and assert expected `menu`, `execution.status`, `execution.mode`, `coordinator_session_id`, model-deferral no-op, and Cursor `unsupported_mode`/pending outcome. Run `bun test test/workit-core/contracts.test.ts test/workit-core/execution-reliability-parity.test.ts test/workit-cursor/runtime-parity.test.ts test/workit-cli/scaffold-parity.test.ts`; expected result is FAIL on stale copies or missing state fields.
- [ ] **Step 2: Synchronize docs and distribution assets.** Update README, AGENTS, host READMEs, canonical/copied contracts and skills, and CHANGELOG Unreleased for this repair only. Document that Cursor remains inline-only and model selection is host-native; do not add Pi/tool-rename roadmap content or claim Marketplace publication.
- [ ] **Step 3: Create Task 5's initial commit.** Use the approved `wk-commit` flow to create one non-empty commit with message `docs: document reliable OpenCode execution` containing the Task 5 parity tests and docs. This establishes Task 5's review range before any fix round.
- [ ] **Step 4: Run focused regression groups.** Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts test/workit-core/handoff.test.ts test/workit-core/sdd.test.ts test/workit-core/execution-reliability-parity.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts test/workit-opencode/plugin-reminder.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-cli/flow-parity.test.ts`; expected result is PASS.
- [ ] **Step 5: Run repository verification.** Run `workflow_verify`, `bun run check`, `bun run verify:release-candidate`, and `bun run validate:cursor-marketplace`; every discovered check must exit 0. Run `workflow_docs_validate` for this spec/plan pair and fix every hard finding before proceeding.
- [ ] **Step 6: Run final review and resolve blocking findings.** Dispatch fresh spec-compliance and code-quality reviewers over the complete branch. Apply only verified blocking fixes as new commits appended to Task 5's existing range, and re-run the affected focused checks plus `workflow_verify`.
- [ ] **Step 7: Complete the flow.** Append the validated Task 5 ledger line with its real non-empty range, confirm all task IDs are complete, then call `workflow_plan_complete`; expected final execution status is `completed`.

**Criteria:** CA-18 through CA-20 pass; all host contracts agree, full verification is green, and the plan is completed rather than left active.

| Status | Task |
| --- | --- |
| pending | 5: Host parity, documentation, and full verification |
