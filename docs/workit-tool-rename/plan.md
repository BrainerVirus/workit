# Rename workflow_* to workit_* Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workit-tool-rename/spec.md`
**Branch:** `feature/workit-tool-rename`

**Goal:** Mechanically rename every `workflow_*` tool identifier to `workit_*` across both host adapters, shared core, tests, skills, and docs, keeping host-specific names per-host and legacy brand strings untouched.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- TDD rails: write the failing test first, watch it fail, then write the minimal code to pass.
- Verification rail: no completion claim without running `bun run check` (or `workflow_verify`) and showing its output.
- Preserve the existing comment style in files being edited; do not add new comments.

---

### Task 1: Rename the OpenCode plugin tools (TDD)

- [ ] **Step 1: Update the failing tests.** In `test/workit-opencode/*` (bootstrap, plugin, flow-enforcement, doctor, logging, docs-migration) and `test/artifacts/registration.test.ts`, change every `workflow_*` tool-name assertion to `workit_*` (e.g. `workflow_verify` → `workit_verify`, `workflow_flow_status` → `workit_flow_status`, `workflow_commit` → `workit_commit`, `workflow_handoff_session` → `workit_handoff_session`). Run the focused tests and confirm they fail (RED).
- [ ] **Step 2: Rename the OpenCode tool keys.** In `packages/workit-opencode/src/tools/*.ts` (flow, repo, sdd, docs-repo, templates, rules, youtrack, present, doctor, handoff) and `packages/workit-opencode/src/bootstrap.ts`, rename every `workflow_*` tool identifier to `workit_*`. Keep host-specific names (`workit_commit`, `workit_handoff_session`) as-is on OpenCode. Do not change any tool logic.
- [ ] **Step 3: Confirm GREEN.** Run the focused `test/workit-opencode` + `test/artifacts/registration.test.ts` and confirm they pass.

**Criteria:** `bun test test/workit-opencode test/artifacts/registration.test.ts` pass after the rename; RED observed before.

| Status | Task |
| --- | --- |
| pending | 1: Rename the OpenCode plugin tools (TDD) |

---

### Task 2: Rename the Cursor MCP server tools (TDD)

- [ ] **Step 1: Update the failing tests.** In `test/workit-cursor/*` (mcp-process, mcp-regressions, mcp-errors, doctor, flow-enforcement, docs-migration) and `test/artifacts/packed-runtime.test.ts`, change every `workflow_*` tool-name assertion to `workit_*` (e.g. `workflow_verify` → `workit_verify`, `workflow_handoff_prompt` → `workit_handoff_prompt`). Run focused tests and confirm they fail (RED).
- [ ] **Step 2: Rename the Cursor MCP tool names.** In `packages/workit-cursor/mcp/server.ts`, rename every `registerTool("workflow_*", ...)` first argument to `workit_*`, and update the `lifecycleTool` template `` `workflow_plan_${action}` `` to `workit_plan_${action}`. Keep `workit_handoff_prompt` as the Cursor-specific handoff name. Update the inline string at server.ts:365 (`workflow_changelog_apply` → `workit_changelog_apply`).
- [ ] **Step 3: Confirm GREEN.** Run the focused `test/workit-cursor` and confirm they pass.

**Criteria:** `bun test test/workit-cursor test/artifacts/packed-runtime.test.ts` pass after the rename; RED observed before.

| Status | Task |
| --- | --- |
| pending | 2: Rename the Cursor MCP server tools (TDD) |

---

### Task 3: Rename shared-core strings and the mutation allowlist

- [ ] **Step 1: Update the failing tests.** In `test/workit-core/*` (flow-state, flow-tools, flow-concurrency, flow-enforcement, handoff, contracts, sdd, youtrack, docs-layout, docs-paths, docs-repo-tools, docs-validate, template-tools, rules-tools, repo, pr-create, config-guard, branch-policy, quality-tools, enforcement-rails, host-boundaries) and `test/artifacts/phase-0-candidate.test.ts` + `phase-9-traceability.test.ts`, change every `workflow_*` tool-name assertion to `workit_*`. Run focused tests and confirm they fail (RED).
- [ ] **Step 2: Rename the shared-core string literals.** In `packages/workit-core/src/core/` (detector.ts regex, repo-context.ts, docs-repo.ts, youtrack.ts retry, youtrack-tools.ts retry types/values, sdd.ts, reminder.ts, branch.ts, flow-state.ts error/prose strings) and the **mutation-tool allowlist** in flow-state.ts (every `workflow_*` entry → `workit_*`, keeping the existing `workit_init_apply`), rename all `workflow_*` tool-name references to `workit_*`. Do not touch legacy brand strings.
- [ ] **Step 3: Confirm GREEN.** Run the focused `test/workit-core` and confirm they pass.

**Criteria:** `bun test test/workit-core test/artifacts/phase-0-candidate.test.ts test/artifacts/phase-9-traceability.test.ts` pass after the rename; RED observed before.

| Status | Task |
| --- | --- |
| pending | 3: Rename shared-core strings and the mutation allowlist |

---

### Task 4: Rename skills, assets, and templates

- [ ] **Step 1: Rename tool references in skills.** Update every `workflow_*` tool reference to `workit_*` in `packages/*/skills/**/SKILL.md` and `wk-issue-update/references/*.md` across `packages/workit-core`, `packages/workit-opencode/assets`, `packages/workit-cursor`, and `packages/workit-cli/assets` (about 47 files).
- [ ] **Step 2: Rename template tool references.** Update `packages/*/assets/templates/*.md` (execution-contract, plan-template, spec-template, superpowers-doc-contract) and `packages/workit-opencode/assets/vendor/superpowers/skills/subagent-driven-development/SKILL.md` to reference `workit_*` tool names.
- [ ] **Step 3: Verify.** Run the marketplace validator and skill-manifest checks (`bun run validate:cursor-marketplace`) and confirm the renamed skill references are consistent.

**Criteria:** `bun run validate:cursor-marketplace` passes; a repo-wide grep for `workflow_` tool identifiers in skills/assets/templates (excluding legacy brand strings) returns none.

| Status | Task |
| --- | --- |
| pending | 4: Rename skills, assets, and templates |

---

### Task 5: Docs, policy, changelog, full verification, and completion

- [ ] **Step 1: Update README/AGENTS/CHANGELOG.** Update root README, `packages/workit-cursor/README.md`, `packages/workit-opencode/README.md` (if present), and AGENTS.md to reference `workit_*` tool names; add a CHANGELOG Unreleased entry describing the full tool rename. Keep legacy brand strings.
- [ ] **Step 2: Run full verification.** Run `bun run check` (and `workflow_verify`), plus `bun run validate:cursor-marketplace`, confirming lint, format:check, tests, build, and changelog all pass. Confirm a grep for `workflow_` tool identifiers (excluding legacy brand strings) in source/skills/docs returns none.
- [ ] **Step 3: Complete the plan.** Confirm the SDD ledger is complete and repository verification passes, then call `workflow_plan_complete` (or `workit flow complete`). The plan must not remain `active`.

**Criteria:** `workflow_verify` / `bun run check` reports all gates pass (exit 0); plan transitions to `completed`.

| Status | Task |
| --- | --- |
| pending | 5: Docs, policy, changelog, full verification, and completion |
