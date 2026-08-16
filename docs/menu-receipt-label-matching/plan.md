# Menu Receipt Label Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/menu-receipt-label-matching/spec.md`
**Branch:** `bugfix/menu-receipt-label-matching`

**Goal:** Make menu-choice receipt matching robust to host-added label qualifiers so no menu option can fail to bind, without weakening the fabrication guard.

## Global Constraints

- No production code without a failing test first (TDD rail).
- Core logic lives in `packages/workit-core/src/core/`; adapters map host-native surfaces only.
- Parity: identical accept/reject outcomes through core, OpenCode tool wrapper, and Cursor MCP/CLI surfaces.
- No worktrees; in-place branch `bugfix/menu-receipt-label-matching` (already created).
- The `(Recommended)` and `(new session only)` qualifiers are host/display behavior — the fix normalizes in the shared matcher, it does not strip stored label bytes.
- Negative-answer, freshness, one-use, and fabrication semantics are unchanged.
- Docs, AGENTS.md, and CHANGELOG Unreleased updated in the same change (parity rule 3).
- Cursor Marketplace pin `@brainervirus/workit-cursor@0.8.0` is never weakened.

---

### Task 1: Failing tests for qualifier-decorated menu labels

- [ ] **Step 1:** In `test/workit-core/flow-enforcement.test.ts`, add failing tests: `recordMenuChoice` accepts receipts whose `selectedLabel` is `Subagent-driven (Recommended)`, `Handoff (new session only)`, `Inline (Recommended)`, `Review spec first`, and `Review plan first` for their respective enums, on both a source flow and a marked handoff destination.
- [ ] **Step 2:** Add a failing test that a genuinely mismatched base label (`Implement` for `inline`, `Handoff` for `review-spec`) is still rejected with `evidence_mismatch`.
- [ ] **Step 3:** In the receipt-store tests (same file or `flow-state.test.ts`), add a failing test that `consume` with `opts.label` accepts `Handoff (new session only)` for `handoff`.

**Criteria:** New tests fail before the fix and pass after; existing evidence/fabrication tests unchanged.

| Status | Task |
| --- | --- |
| pending | 1: Failing tests for qualifier-decorated menu labels |

### Task 2: Shared normalized label matcher

- [ ] **Step 1:** Replace `sameChoiceLabel` in `packages/workit-core/src/core/flow-state.ts` with a matcher that strips parenthesized qualifiers (`/\s*\([^)]*\)/g`), strips a trailing `first` qualifier, collapses hyphens/extra whitespace to single spaces, trims, and lowercases both sides before comparing.
- [ ] **Step 2:** Route every label comparison through the shared matcher: `HostReceiptStore.consume` (`opts.label` filter) and `recordMenuChoice` evidence check; verify no other call site compares labels directly.
- [ ] **Step 3:** Confirm the stored `selectedLabel` and evidence bytes are untouched (provenance preserved).

**Criteria:** Task 1 tests pass; stored labels byte-identical; `rg "selectedLabel" packages/workit-core/src` shows only the shared matcher comparing labels.

| Status | Task |
| --- | --- |
| pending | 2: Shared normalized label matcher |

### Task 3: Parity across adapters

- [ ] **Step 1:** Add parity tests through the OpenCode `workflow_plan_menu` tool wrapper (`test/workit-core/flow-enforcement.test.ts` or the opencode adapter suite) with `(Recommended)`-decorated receipts for each choice.
- [ ] **Step 2:** Add Cursor MCP/CLI parity assertions (policy-only confirmation path) that decorated labels on host-observed receipts do not change outcomes where the label check applies.
- [ ] **Step 3:** Add a contract test asserting the plugin question labels match the documented display forms (`SOURCE_MENU_LABELS`/`DESTINATION_MENU_LABELS`) so future rewording surfaces a test failure.

**Criteria:** Parity tests pass; contract test pins the display labels; no host-specific label logic added to adapters.

| Status | Task |
| --- | --- |
| pending | 3: Parity across adapters |

### Task 4: Documentation and changelog

- [ ] **Step 1:** Update README/`AGENTS.md` where receipt label matching is described (approval/menu evidence sections) to state that host qualifiers are normalized at comparison time and original labels are preserved.
- [ ] **Step 2:** Update CHANGELOG.md Unreleased with a `### Fixed` entry: menu receipt label matching now tolerates host qualifiers such as `(Recommended)` and `(new session only)`.

**Criteria:** `workflow_verify` changelog check passes; docs match verified behavior.

| Status | Task |
| --- | --- |
| pending | 4: Documentation and changelog |

### Task 5: Full verification

- [ ] **Step 1:** Run `workflow_verify` (lint, format:check, tests, build, changelog) and fix any failures introduced by this feature.
- [ ] **Step 2:** Re-run the focused suites (`flow-enforcement.test.ts`, `flow-state.test.ts`, opencode/cursor flow suites) and confirm all pass.

**Criteria:** `workflow_verify` passes (the known intermittent TTY flake `Back preserves the draft values entered so far`, when it occurs, is pre-existing and passes in isolation).

| Status | Task |
| --- | --- |
| pending | 5: Full verification |
