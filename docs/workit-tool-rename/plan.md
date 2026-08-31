# Rename workflow_* to workit_* Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workit-tool-rename/spec.md`
**Branch:** `feature/workit-tool-rename`

**Goal:** Rename every live `workflow_*` tool identifier to `workit_*` across both host adapters, shared core, tests, skills, templates, and tracked documentation.

**Architecture:** OpenCode and Cursor keep their existing independent literal tool declarations, while the shared core strings and mutation allowlist are updated to the same `workit_*` namespace. Host-only behavior remains host-only: OpenCode has `workit_commit` and `workit_handoff_session`; Cursor has `workit_handoff_prompt`.

**Tech Stack:** TypeScript/Bun, OpenCode native tools, Cursor MCP, Markdown skills/templates, shell/CLI contract tests.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with plan completion; the current orchestration tool is `workflow_plan_complete` and becomes `workit_plan_complete` when this rename lands, or use CLI `workit flow complete`.
- TDD rail: update the relevant test expectation first, run it and observe failure, then rename the corresponding production/documentation references and run the focused test.
- Legacy exact strings `workflow-toolkit`, `workflow_toolkit` without a tool suffix, and `workflow-toolkit-contract` remain unchanged for legacy detection; inspect mixed-content lines manually.
- The current `workflow_*` names in this plan's orchestration instructions are transition references required to execute the pre-rename workflow; Task 5 verifies the shipped post-rename names.

---

### Task 1: Rename OpenCode native tools

**Files:**
- Modify: `packages/workit-opencode/src/bootstrap.ts`
- Modify: `packages/workit-opencode/src/tools/flow.ts`
- Modify: `packages/workit-opencode/src/tools/repo.ts`
- Modify: `packages/workit-opencode/src/tools/sdd.ts`
- Modify: `packages/workit-opencode/src/tools/docs-repo.ts`
- Modify: `packages/workit-opencode/src/tools/templates.ts`
- Modify: `packages/workit-opencode/src/tools/rules.ts`
- Modify: `packages/workit-opencode/src/tools/youtrack.ts`
- Modify: `packages/workit-opencode/src/tools/present.ts`
- Modify: `packages/workit-opencode/src/tools/doctor.ts`
- Modify: `packages/workit-opencode/src/tools/handoff.ts`
- Test: `test/workit-opencode/bootstrap.test.ts`
- Test: `test/workit-opencode/plugin.test.ts`
- Test: `test/workit-opencode/plugin-reminder.test.ts`
- Test: `test/workit-opencode/flow-enforcement.test.ts`
- Test: `test/workit-opencode/doctor.test.ts`
- Test: `test/workit-opencode/logging.test.ts`
- Test: `test/workit-opencode/docs-migration.test.ts`
- Test: `test/workit-opencode/smoke.ts`
- Test: `test/artifacts/registration.test.ts`

- [ ] **Step 1: Write the failing tests.** Replace the OpenCode tool-name assertions in the listed tests, including `workflow_commit` -> `workit_commit` and `workflow_handoff_session` -> `workit_handoff_session`. Run `bun test test/workit-opencode test/artifacts/registration.test.ts`; expected result is FAIL because the native tool keys still use `workflow_*`.
- [ ] **Step 2: Rename the native tool keys.** Replace each OpenCode object key `workflow_*` with `workit_*` in the listed source files and update the three bootstrap prose references. Do not change tool schemas, handlers, or host-specific behavior.
- [ ] **Step 3: Run the focused tests.** Run `bun test test/workit-opencode test/artifacts/registration.test.ts`; expected result is PASS.
- [ ] **Step 4: Commit the task.** Commit the OpenCode identifier rename and tests as one non-empty task range.

**Criteria:** All 45 OpenCode tool declarations expose `workit_*`; OpenCode-only `workit_commit` and `workit_handoff_session` remain present; focused tests pass.

| Status | Task |
| --- | --- |
| pending | 1: Rename OpenCode native tools |

---

### Task 2: Rename Cursor MCP tools

**Files:**
- Modify: `packages/workit-cursor/mcp/server.ts`
- Test: `test/workit-cursor/docs-migration.test.ts`
- Test: `test/workit-cursor/doctor.test.ts`
- Test: `test/workit-cursor/flow-enforcement.test.ts`
- Test: `test/workit-cursor/mcp-errors.test.ts`
- Test: `test/workit-cursor/mcp-process.test.ts`
- Test: `test/workit-cursor/mcp-regressions.test.ts`
- Test: `test/artifacts/packed-runtime.test.ts`

- [ ] **Step 1: Write the failing tests.** Replace Cursor MCP assertions with `workit_*`, including `workflow_handoff_prompt` -> `workit_handoff_prompt`; add an assertion that no Cursor registration exposes a `workflow_*` name. Run `bun test test/workit-cursor test/artifacts/packed-runtime.test.ts`; expected result is FAIL.
- [ ] **Step 2: Rename MCP registrations.** Replace each `registerTool("workflow_*", ...)` first argument in `server.ts` with `workit_*`; change the lifecycle template from `` `workflow_plan_${action}` `` to `` `workit_plan_${action}` ``; update the inline changelog instruction string. Keep Cursor's `workit_handoff_prompt`; do not add OpenCode-only `commit` or `handoff_session` tools.
- [ ] **Step 3: Run the focused tests.** Run `bun test test/workit-cursor test/artifacts/packed-runtime.test.ts`; expected result is PASS.
- [ ] **Step 4: Commit the task.** Commit the Cursor MCP identifier rename and tests as one non-empty task range.

**Criteria:** All 45 Cursor MCP registrations (42 literal + 3 template-generated lifecycle) expose `workit_*`; `workit_handoff_prompt` remains Cursor-only; focused tests pass.

| Status | Task |
| --- | --- |
| pending | 2: Rename Cursor MCP tools |

---

### Task 3: Rename shared-core strings and mutation allowlist

**Files:**
- Modify: `packages/workit-core/src/core/detector.ts`
- Modify: `packages/workit-core/src/core/repo-context.ts`
- Modify: `packages/workit-core/src/core/docs-repo.ts`
- Modify: `packages/workit-core/src/core/youtrack.ts`
- Modify: `packages/workit-core/src/core/youtrack-tools.ts`
- Modify: `packages/workit-core/src/core/sdd.ts`
- Modify: `packages/workit-core/src/core/reminder.ts`
- Modify: `packages/workit-core/src/core/branch.ts`
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Test: `test/workit-core/branch-policy.test.ts`
- Test: `test/workit-core/config-guard.test.ts`
- Test: `test/workit-core/contracts.test.ts`
- Test: `test/workit-core/docs-layout.test.ts`
- Test: `test/workit-core/docs-paths.test.ts`
- Test: `test/workit-core/docs-repo-tools.test.ts`
- Test: `test/workit-core/docs-validate.test.ts`
- Test: `test/workit-core/enforcement-rails.test.ts`
- Test: `test/workit-core/flow-concurrency.test.ts`
- Test: `test/workit-core/flow-enforcement.test.ts`
- Test: `test/workit-core/flow-state.test.ts`
- Test: `test/workit-core/flow-tools.test.ts`
- Test: `test/workit-core/handoff.test.ts`
- Test: `test/workit-core/host-boundaries.test.ts`
- Test: `test/workit-core/pr-create.test.ts`
- Test: `test/workit-core/quality-tools.test.ts`
- Test: `test/workit-core/repo.test.ts`
- Test: `test/workit-core/rules-tools.test.ts`
- Test: `test/workit-core/sdd.test.ts`
- Test: `test/workit-core/template-tools.test.ts`
- Test: `test/workit-core/youtrack.test.ts`
- Test: `test/artifacts/phase-0-candidate.test.ts`
- Test: `test/artifacts/phase-9-traceability.test.ts`

- [ ] **Step 1: Write the failing tests.** Replace shared-core assertions and retry-tool names with `workit_*`, including the full mutation allowlist. Run `bun test test/workit-core test/artifacts/phase-0-candidate.test.ts test/artifacts/phase-9-traceability.test.ts`; expected result is FAIL until core strings are renamed.
- [ ] **Step 2: Rename shared-core references.** Update the detector regex, repo/docs error guidance, YouTrack retry types and values, SDD/reminder/branch prose, flow-state error strings, and every mutation allowlist entry from `workflow_*` to `workit_*`. Do not alter legacy identity strings or behavior.
- [ ] **Step 3: Run the focused tests.** Run the same core/artifact command; expected result is PASS.
- [ ] **Step 4: Commit the task.** Commit shared-core strings, allowlist, and tests as one non-empty task range.

**Criteria:** Core behavior is unchanged except for emitted tool-name strings; the allowlist contains `workit_*` only; focused tests pass.

| Status | Task |
| --- | --- |
| pending | 3: Rename shared-core strings and mutation allowlist |

---

### Task 4: Rename skills, assets, templates, and vendored contracts

**Files:**
- Modify: all 12 `packages/workit-core/skills/*/SKILL.md` files and YouTrack reference
- Modify: the corresponding 12 files under `packages/workit-opencode/assets/skills/`
- Modify: the corresponding 12 files under `packages/workit-cursor/skills/`
- Modify: `packages/workit-core/templates/**`
- Modify: `packages/workit-opencode/assets/templates/**`
- Modify: `packages/workit-cursor/assets/templates/**`
- Modify: `packages/workit-cli/assets/templates/**`
- Modify: `packages/workit-opencode/assets/vendor/superpowers/skills/subagent-driven-development/SKILL.md`
- Modify: `packages/workit-core/vendor/superpowers/skills/subagent-driven-development/SKILL.md`
- Modify: `packages/workit-cursor/vendor/superpowers/skills/subagent-driven-development/SKILL.md`
- Test: `test/artifacts/package-contents.test.ts`
- Test: `test/artifacts/packed-runtime.test.ts`
- Test: `test/artifacts/phase-9-traceability.test.ts`

- [ ] **Step 1: Write the failing content tests.** Update package-content and traceability expectations to require `workit_*` references in shipped skills/templates and reject live `workflow_*` references. Run `bun test test/artifacts/package-contents.test.ts test/artifacts/packed-runtime.test.ts test/artifacts/phase-9-traceability.test.ts`; expected result is FAIL.
- [ ] **Step 2: Rename skill and template references.** Replace live tool identifiers in every listed skill, reference, template, and vendor file. Preserve legacy brand strings and historical prose that is not a tool identifier.
- [ ] **Step 3: Verify the shipped tree.** Run `bun run validate:cursor-marketplace` and the three content tests; expected result is PASS.
- [ ] **Step 4: Commit the task.** Commit skills, assets, templates, vendor copies, and content tests as one non-empty task range.

**Criteria:** All shipped skill/asset/template/vendor trees use `workit_*` live identifiers; Marketplace and content gates pass.

| Status | Task |
| --- | --- |
| pending | 4: Rename skills, assets, templates, and vendored contracts |

---

### Task 5: Tracked docs, parity, verification, and completion

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: every tracked `docs/**/*.md` file containing a live `workflow_*` tool identifier
- Test: `test/workit-cli/flow-parity.test.ts`
- Test: `test/workit-opencode/plugin-reminder.test.ts`
- Test: `test/workit-opencode/smoke.ts`

- [ ] **Step 1: Update documentation expectations.** Extend `test/workit-cli/flow-parity.test.ts` and the OpenCode reminder/smoke checks to assert the common `workit_*` namespace and the documented host-only differences. Run these tests and confirm RED before docs are renamed.
- [ ] **Step 2: Rename tracked documentation references.** Update root README, AGENTS.md, package READMEs, CHANGELOG Unreleased, and every tracked `docs/**/*.md` live tool identifier to `workit_*`; preserve exact legacy brand strings used for migration detection. Add a concise Unreleased entry describing the complete tool rename.
- [ ] **Step 3: Run the complete identifier audit.** Run `rg -nP 'workflow_[a-z][a-z0-9_]*' packages test docs README.md AGENTS.md CHANGELOG.md` and inspect every match; remaining matches may only be exact legacy brand strings, never a suffixed live tool identifier. Run the explicit host-set parity test and expected result is PASS.
- [ ] **Step 4: Run full verification.** Run `bun run check`, `bun run validate:cursor-marketplace`, and the repository verification command; expected result is exit 0 for lint, format, tests, build, changelog, and Marketplace validation.
- [ ] **Step 5: Complete the SDD ledger and plan.** Append one validated progress line for task IDs 1-5 with each task's real non-empty `base..head` range, then call plan completion after verification; use the current `workflow_*` orchestration name before this rename is loaded and `workit_*` afterward.
- [ ] **Step 6: Commit the task.** Commit tracked documentation, parity tests, and final verification updates as one non-empty task range.

**Criteria:** No live `workflow_*` tool identifier remains in source, tests, shipped content, or tracked docs; legacy brand strings remain; parity and full verification pass; the plan is completed.

| Status | Task |
| --- | --- |
| pending | 5: Tracked docs, parity, verification, and completion |
