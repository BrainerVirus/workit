# Cursor Plugin Auto-Load Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-plugin-autoload-repair/spec.md`
**Branch:** `feature/cursor-plugin-autoload-repair`

**Goal:** Detect stale Cursor plugin installs and self-heal them so the sessionStart hook and MCP server auto-load a current runtime.

**Architecture:** The doctor gains a `stale_install` check comparing the installed plugin version/selectors against the current runtime source of truth (`registration.ts`); the installer runs the same check before registering and refreshes the workit-owned Cursor entries when stale. Registry-unreachable comparisons fail open as `registry_unreachable`.

**Tech Stack:** TypeScript/Bun, shell installer, Cursor MCP/hook JSON, Bun tests, npm registry read.

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with plan completion (current host tool `workflow_plan_complete`; after the rename spec lands, `workit_plan_complete`, or CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes.
- TDD rail: write the failing test first, run it and observe failure, then write the minimum production change and run the focused test again.
- Repair only workit-owned Cursor entries; never touch unrelated MCP servers/settings.
- Preserve the `@latest` + `--prefer-online` selector policy from the merged runtime spec.

---

### Task 1: Doctor stale-install detection (TDD)

**Files:**
- Modify: `packages/workit-core/src/core/doctor.ts`
- Modify: `test/workit-core/doctor.test.ts`

- [ ] **Step 1: Write the failing tests.** Add doctor tests asserting: (a) a stale installed plugin version (e.g. installed `0.4.0` while the current runtime source reports a newer selector) yields a structured `stale_install` finding; (b) a legacy exact npx pin (`@0.8.0`-style) in the plugin's `mcp.json` yields `stale_install`; (c) a current canonical install yields no `stale_install`; (d) a registry-unreachable staleness comparison yields `registry_unreachable`, not `stale_install`. Run `bun test test/workit-core/doctor.test.ts`; expected result is FAIL (no stale check yet).
- [ ] **Step 2: Implement the stale check.** In `packages/workit-core/src/core/doctor.ts`, add a `staleInstallFinding` check that reads the installed plugin's `package.json` version and its `mcp.json`/`hooks-cursor.json` selectors, compares against the current runtime source of truth (`CURSOR_RUNTIME_PACKAGE` / the canonical entry builders from `registration.ts`), and reports `stale_install` with the repair step. Registry reads must fail open to `registry_unreachable`.
- [ ] **Step 3: Confirm GREEN.** Run `bun test test/workit-core/doctor.test.ts`; expected result is PASS.

**Criteria:** Doctor reports `stale_install` for stale versions/legacy pins, no finding for canonical installs, `registry_unreachable` on registry failure.

| Status | Task |
| --- | --- |
| pending | 1: Doctor stale-install detection (TDD) |

---

### Task 2: Installer self-heal (TDD)

**Files:**
- Modify: `packages/workit-core/scripts/install-cursor-plugin.sh`
- Modify: `packages/workit-core/scripts/doctor-check.ts` (if it needs a stale flag)
- Modify: `test/workit-core/install-scripts.test.ts`
- Modify: `test/workit-core/cursor-install-mcp.test.ts`

- [ ] **Step 1: Write the failing tests.** Add installer tests asserting: (a) running the installer against a stale plugin dir (old version + legacy pin) refreshes the plugin dir and rewrites the workit MCP/hook entries to the canonical current selector, preserving unrelated MCP servers; (b) the stale → repaired transition ends with a healthy doctor; (c) a healthy install is left untouched. Run `bun test test/workit-core/install-scripts.test.ts test/workit-core/cursor-install-mcp.test.ts`; expected result is FAIL.
- [ ] **Step 2: Implement self-heal.** In `packages/workit-core/scripts/install-cursor-plugin.sh`, before registering, run the stale check; when stale, refresh the plugin directory from the share/dev root and rewrite the workit MCP/hook entries (default npx `@latest` + `--prefer-online`, or the current local-dist launcher), preserving unrelated settings. A registry-unreachable staleness comparison fails open as `registry_unreachable` — no false `stale_install` and no install failure. Re-run the doctor after repair.
- [ ] **Step 3: Confirm GREEN.** Run the focused installer tests; expected result is PASS.

**Criteria:** Installer self-heals a stale install (refresh + canonical re-registration), preserves unrelated settings, and verifies healthy after repair.

| Status | Task |
| --- | --- |
| pending | 2: Installer self-heal (TDD) |

---

### Task 3: Real-machine repair + auto-load verification

**Files:**
- Verify: real `~/.cursor/plugins/local/workit/`, `~/.cursor/mcp.json`, `~/.cursor/settings.json` (no repository changes except tests/docs)

- [ ] **Step 1: Verify the real machine.** Run `packages/workit-core/scripts/install-cursor-plugin.sh` against the real install; confirm the doctor passes, the installed plugin is refreshed to the current runtime, and unrelated MCP servers survive. This replaces the stale 0.4.0 local-dist with a current registration.
- [ ] **Step 2: Verify auto-load.** Confirm the sessionStart hook command is the canonical current selector and the workit MCP entry registers per workspace; report the resulting state (the hook/MCP now load on session start).
- [ ] **Step 3: Commit the task.** Commit any verification-only tracked changes (tests/docs updates) as one non-empty task range; keep `docs/<slug>/sdd/` gitignored.

**Criteria:** Real install healthy after repair; auto-load registration confirmed; unrelated settings preserved.

| Status | Task |
| --- | --- |
| pending | 3: Real-machine repair + auto-load verification |

---

### Task 4: Docs, verification, and completion

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update docs.** Add a CHANGELOG Unreleased entry describing stale-install detection + installer self-heal; update README/AGENTS/Cursor README with the auto-load repair behavior (doctor `stale_install` finding, installer self-heal, fail-open on registry unreachable).
- [ ] **Step 2: Run full verification.** Run `bun run check` (lint, format:check, test, build, changelog), `bun run verify:release-candidate`, `bun run validate:cursor-marketplace`, and `workflow_docs_validate` for the spec/plan pair; all must exit 0.
- [ ] **Step 3: Complete the SDD ledger and plan.** Confirm the task list, append one validated progress line per task with real non-empty ranges, then call plan completion after verification passes; the plan must not remain `active`.

**Criteria:** `workflow_verify` / `bun run check` all gates pass (exit 0); plan transitions to `completed`.

| Status | Task |
| --- | --- |
| pending | 4: Docs, verification, and completion |
