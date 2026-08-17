# Cursor Runtime @latest + --prefer-online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-runtime-latest/spec.md`
**Branch:** `feature/cursor-runtime-latest`

**Goal:** Replace the hand-maintained exact Cursor runtime pin with `@latest` + `--prefer-online` across source, manifests, doctor, tests, and docs.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- TDD rails: write the failing test first, watch it fail, then write the minimal code to pass.
- Verification rail: no completion claim without running `bun run check` (or `workflow_verify`) and showing its output.
- Do not add comments unless the existing style requires them; preserve the existing doc-comment style in the files being edited.

---

### Task 1: Core selector + doctor (TDD)

- [ ] **Step 1: Update the failing tests.** In `test/artifacts/registration.test.ts`, `test/workit-core/doctor.test.ts`, `test/workit-core/doctor-fixture.ts` (via `test/shared/helpers/doctor-fixture.ts`), flip the canonical selector from `@0.8.5` to `@latest` + `--prefer-online`. Change the doctor negative variants so the new rejected set is: exact pin `@0.8.5`, bare `@latest` without `--prefer-online`, `@latest-alpha`, `@0.8.5-alpha`, `@0.8.50`, and an executable lookalike. Assert the canonical MCP launcher args are exactly `["-y", "--prefer-online", "--package=@brainervirus/workit-cursor@latest", "workit-cursor-mcp", "${workspaceFolder}"]` and the canonical hook is `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. Run the focused tests and confirm they fail (RED).
- [ ] **Step 2: Update `registration.ts`.** Change `CURSOR_RUNTIME_PACKAGE` value to `"@brainervirus/workit-cursor@latest"` and update its doc comment to state the `--prefer-online` + `@latest` strategy. Update `cursorMcpServerEntry` to emit `["-y", "--prefer-online", "--package=@brainervirus/workit-cursor@latest", "workit-cursor-mcp", "${workspaceFolder}"]` and `cursorHooksEntry` to emit `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. Keep the local-dist entries unchanged.
- [ ] **Step 3: Update `doctor.ts`.** Update `registeredCursorLauncher` to require `args[1] === "--prefer-online"` and `args[2] === "--package=@brainervirus/workit-cursor@latest"` (positional), and update `canonicalCursorHook` accordingly. Run the focused tests and confirm they pass (GREEN).

**Criteria:** `bun test test/artifacts/registration.test.ts test/workit-core/doctor.test.ts test/workit-core/install-scripts.test.ts test/workit-core/cursor-install-mcp.test.ts` pass after the change; RED observed before.

| Status | Task |
| --- | --- |
| pending | 1: Core selector + doctor (TDD) |

---

### Task 2: Committed manifests, shell entry, and CLI-derived surfaces

- [ ] **Step 1: Update failing tests.** In `test/artifacts/manifests.test.ts` flip the canonical `@0.8.5` selectors and the `CURSOR_RUNTIME_PACKAGE` literal to `@latest` + `--prefer-online`, and set the negative-variant set to `["0.8.5", "latest-alpha", "0.8.5-alpha", "0.8.50"]` with the added requirement that `--prefer-online` is present. Update `test/artifacts/phase-0-candidate.test.ts`, `test/workit-cli/packed-cli.test.ts`, `test/workit-core/contracts.test.ts` (flip the `not.toMatch(/workit-cursor@latest/)` assertion to require `@latest`), `test/workit-cursor/mcp-process.test.ts`, `test/workit-cursor/mcp-regressions.test.ts`, and `test/workit-core/install-scripts.test.ts`. Run focused tests and confirm RED.
- [ ] **Step 2: Update the committed manifests.** Change `packages/workit-cursor/mcp.json` to `["-y", "--prefer-online", "--package=@brainervirus/workit-cursor@latest", "workit-cursor-mcp", "${workspaceFolder}"]` and `packages/workit-cursor/hooks/hooks-cursor.json` to `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. Update `packages/workit-core/scripts/run-cursor-mcp.sh` to the same `--prefer-online` + `@latest` form.
- [ ] **Step 3: Run focused tests + Marketplace validation.** Confirm GREEN on the touched test files and run `bun run validate:cursor-marketplace` to confirm the clean-checkout Marketplace gate accepts the new selector.

**Criteria:** `bun test test/artifacts test/workit-cli/packed-cli.test.ts test/workit-core/contracts.test.ts test/workit-cursor` pass; `bun run validate:cursor-marketplace` passes.

| Status | Task |
| --- | --- |
| pending | 2: Committed manifests, shell entry, and CLI-derived surfaces |

---

### Task 3: Docs, policy, and changelog

- [ ] **Step 1: Update AGENTS.md.** Rewrite the Cursor runtime pinning policy (rule 5 and the README "Update review" references) to state that the runtime runs `@latest` with `--prefer-online` (never a stale-cache-exposed selector), and remove the "never a mutable latest dist-tag" wording.
- [ ] **Step 2: Update READMEs.** Update root `README.md` and `packages/workit-cursor/README.md` runtime/pinning sections from `@0.8.5` to `@latest` + `--prefer-online`, and rewrite the "Update review"/"Runtime" sections to describe the new strategy (no per-release bump needed).
- [ ] **Step 3: Update CHANGELOG.** Add an Unreleased entry under the appropriate category describing the switch from the exact pin to `@latest` + `--prefer-online`, noting the doctor now enforces the canonical shape and rejects exact pins.

**Criteria:** `bun run format:check`, `bun run lint`, and `bun run check` (full) pass; no `0.8.5` runtime-selector reference remains in docs/AGENTS; CHANGELOG Unreleased updated.

| Status | Task |
| --- | --- |
| pending | 3: Docs, policy, and changelog |

---

### Task 4: Full verification and completion

- [ ] **Step 1: Run full verification.** Run `bun run check` (and `workflow_verify`), confirming lint, format:check, tests, build, and changelog all pass; re-run `bun run validate:cursor-marketplace` and the release-candidate verification.
- [ ] **Step 2: Complete the plan.** Confirm the SDD ledger is complete (all task IDs appended) and repository verification passes, then call `workflow_plan_complete` (or `workit flow complete`). The plan must not remain `active`.

**Criteria:** `workflow_verify` / `bun run check` reports all gates pass (exit 0); plan transitions to `completed`.

| Status | Task |
| --- | --- |
| pending | 4: Full verification and completion |
