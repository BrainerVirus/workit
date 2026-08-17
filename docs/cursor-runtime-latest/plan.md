# Cursor Runtime @latest + --prefer-online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-runtime-latest/spec.md`
**Branch:** `feature/cursor-runtime-latest`

**Goal:** Replace the hand-maintained exact Cursor runtime pin with `@latest` + `--prefer-online` across source, manifests, doctor, tests, and docs.

**Architecture:** The shared registration helper emits one canonical npx selector, static Marketplace manifests carry the same selector, and the offline doctor enforces its exact positional shape. The local-dist installer remains a separate node launcher and is not changed.

**Tech Stack:** TypeScript/Bun, static JSON manifests, POSIX shell, npm `npx`, Cursor Marketplace validation, Bun tests.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with plan completion (the current host tool is `workflow_plan_complete`; after the tool rename it is `workit_plan_complete`, or use CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes.
- TDD rail: write the failing test first, run it and observe failure, then write the minimum production change and run the focused test again.
- Verification rail: run the exact commands listed below; `workflow_verify` is the current repository verification tool name before the sibling rename spec lands.
- Do not add comments unless the existing style requires them; preserve the existing doc-comment style in edited files.

---

### Task 1: Core selector + doctor (TDD)

**Files:**
- Modify: `test/artifacts/registration.test.ts`
- Modify: `test/workit-core/doctor.test.ts`
- Modify: `test/shared/helpers/doctor-fixture.ts`
- Modify: `packages/workit-core/src/core/registration.ts`
- Modify: `packages/workit-core/src/core/doctor.ts`

- [ ] **Step 1: Write the failing tests.** In the three test files, set the canonical MCP args to exactly `["-y", "--prefer-online", "--package=@brainervirus/workit-cursor@latest", "workit-cursor-mcp", "${workspaceFolder}"]` and the canonical hook to exactly `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. Add rejected MCP variants for an exact `@0.8.5` pin, bare `@latest` without `--prefer-online`, `@latest-alpha`, `@0.8.5-alpha`, `@0.8.50`, missing `${workspaceFolder}`, extra args, and an executable lookalike. Run `bun test test/artifacts/registration.test.ts test/workit-core/doctor.test.ts`; expected result is FAIL because production still emits the old exact pin.
- [ ] **Step 2: Implement the canonical selector.** In `packages/workit-core/src/core/registration.ts`, set `CURSOR_RUNTIME_PACKAGE` to `@brainervirus/workit-cursor@latest`, document that `--prefer-online` is mandatory, add `--prefer-online` after `-y` in `cursorMcpServerEntry`, and add it after `-y` in `cursorHooksEntry`. Leave `cursorMcpLocalDistEntry` and `cursorHookLocalDistEntry` unchanged.
- [ ] **Step 3: Enforce the exact shape.** In `packages/workit-core/src/core/doctor.ts`, require MCP args length 5 and exact positions for `-y`, `--prefer-online`, `--package=@brainervirus/workit-cursor@latest`, `workit-cursor-mcp`, and `${workspaceFolder}`. Require the hook string produced by `cursorHooksEntry("")`, thereby rejecting bare latest, exact pins, lookalikes, missing freshness flag, and extra tokens. Run `bun test test/artifacts/registration.test.ts test/workit-core/doctor.test.ts`; expected result is PASS.
- [ ] **Step 4: Commit the task.** Commit the registration/doctor implementation and focused tests as one non-empty task range.

**Criteria:** Registration and doctor tests pass; local-dist launchers remain accepted; invalid selector variants fail the doctor.

| Status | Task |
| --- | --- |
| pending | 1: Core selector + doctor (TDD) |

---

### Task 2: Committed manifests, shell entry, and installer surfaces

**Files:**
- Modify: `test/artifacts/manifests.test.ts`
- Modify: `test/artifacts/phase-0-candidate.test.ts`
- Modify: `test/workit-cli/packed-cli.test.ts`
- Modify: `test/workit-core/install-scripts.test.ts`
- Modify: `test/workit-core/cursor-install-mcp.test.ts`
- Modify: `test/workit-cursor/mcp-process.test.ts`
- Modify: `test/workit-cursor/mcp-regressions.test.ts`
- Modify: `packages/workit-cursor/mcp.json`
- Modify: `packages/workit-cursor/hooks/hooks-cursor.json`
- Modify: `packages/workit-core/scripts/run-cursor-mcp.sh`

- [ ] **Step 1: Write the failing tests.** Update manifest and installer expectations to require `--prefer-online` plus `@latest`; make negative fixtures reject `@0.8.5`, `@latest-alpha`, `@0.8.5-alpha`, `@0.8.50`, bare latest, and any selector lacking `--prefer-online`. Do not update `test/workit-core/contracts.test.ts` here because it also asserts the policy text changed in Task 3. Run `bun test test/artifacts/manifests.test.ts test/artifacts/phase-0-candidate.test.ts test/workit-core/install-scripts.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/mcp-regressions.test.ts`; expected result is FAIL.
- [ ] **Step 2: Update static launchers.** Change `packages/workit-cursor/mcp.json` to the exact five MCP args from Task 1, change `packages/workit-cursor/hooks/hooks-cursor.json` to `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`, and change `packages/workit-core/scripts/run-cursor-mcp.sh` to `exec npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp "$@"`.
- [ ] **Step 3: Run focused tests and Marketplace validation.** Run `bun test test/artifacts/manifests.test.ts test/artifacts/phase-0-candidate.test.ts test/workit-cli/packed-cli.test.ts test/workit-core/install-scripts.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cursor/mcp-regressions.test.ts` and `bun run validate:cursor-marketplace`; expected result is PASS.
- [ ] **Step 4: Verify the live npm runtime.** Run `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp --help` on Node 22 and confirm it exits 0 and starts the published executable.
- [ ] **Step 5: Commit the task.** Commit manifests, shell entry, installer fixtures, and focused tests as one non-empty task range.

**Criteria:** Static manifests, installer output, shell launcher, and clean-checkout Marketplace validation all use the same canonical selector; live latest smoke starts successfully.

| Status | Task |
| --- | --- |
| pending | 2: Committed manifests, shell entry, and installer surfaces |

---

### Task 3: Docs, policy, and changelog

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `test/workit-core/contracts.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the failing policy test.** Update `test/workit-core/contracts.test.ts` to require the `@latest` + `--prefer-online` policy and reject the old `never latest` wording; run `bun test test/workit-core/contracts.test.ts` and confirm FAIL against the current docs.
- [ ] **Step 2: Update policy and READMEs.** Rewrite `AGENTS.md` rule 5, root `README.md`, and `packages/workit-cursor/README.md` to explain that `@latest` is intentional and `--prefer-online` is mandatory to force registry freshness. Remove exact-pin update instructions and do not claim Marketplace submission.
- [ ] **Step 3: Update the changelog.** Add an Unreleased Changed entry describing the exact-pin to `@latest` + `--prefer-online` switch, the doctor exact-shape gate, and the fact that no per-release manual bump is required.
- [ ] **Step 4: Run the policy test.** Run `bun test test/workit-core/contracts.test.ts`; expected result is PASS.
- [ ] **Step 5: Commit the task.** Commit policy docs, READMEs, changelog, and contract tests as one non-empty task range.

**Criteria:** Docs and tests describe the new strategy consistently; no `@0.8.5` runtime selector or stale "never latest" policy remains in `AGENTS.md` or the active READMEs.

| Status | Task |
| --- | --- |
| pending | 3: Docs, policy, and changelog |

---

### Task 4: Reinstall verification, repository gates, and completion

**Files:**
- Verify: `docs/cursor-runtime-latest/sdd/`
- Verify: real Cursor settings under `~/.cursor/` (no repository changes)

- [ ] **Step 1: Verify the real reinstall.** Run `packages/workit-core/scripts/install-cursor-plugin.sh` in default npx mode against a temporary copy of Cursor settings, then verify unrelated MCP servers/settings survive, the generated `mcp.json` and `hooks-cursor.json` use the canonical selector, and `bun packages/workit-core/scripts/doctor-check.ts cursor` exits 0. Keep the existing `--local-dist` path unchanged and verify it still passes its doctor test.
- [ ] **Step 2: Run all repository verification.** Run `bun run check`, `bun run verify:release-candidate`, `bun run validate:cursor-marketplace`, and `workflow_docs_validate` for `docs/cursor-runtime-latest/spec.md` + `plan.md`; expected result is exit 0 for every command.
- [ ] **Step 3: Complete the SDD ledger.** Use `workflow_sdd_context` to confirm the task list, append one validated progress line for each task with its real non-empty `base..head` range, and run the final branch review before completion.
- [ ] **Step 4: Complete the plan.** After the ledger and verification are green, call the current host's `workflow_plan_complete` (or CLI `workit flow complete`); after the sibling rename spec lands, the equivalent runtime identifier is `workit_plan_complete`. Confirm the state is `completed`, not `active`.
- [ ] **Step 5: Commit the task.** Commit any final verification-only documentation or ledger-related tracked changes as one non-empty task range; keep `docs/<slug>/sdd/` gitignored.

**Criteria:** Live reinstall/doctor, release-candidate verification, Marketplace validation, document validation, full repository gates, complete SDD ledger, and completed plan state all pass.

| Status | Task |
| --- | --- |
| pending | 4: Reinstall verification, repository gates, and completion |
