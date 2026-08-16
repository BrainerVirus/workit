# Windows pr-create test timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/windows-pr-create-test-timeout/spec.md`
**Branch:** `bugfix/windows-pr-create-test-timeout`

**Goal:** Add the file's established 60s per-test budget to the RL-03 pr-create target test so Windows CI stops timing out.

## Global Constraints

- No production code changes.
- No assertion or test-logic changes; only the per-test timeout option.
- No worktrees; in-place branch `bugfix/windows-pr-create-test-timeout` (already created).
- Docs and CHANGELOG Unreleased updated in the same change (parity rule 3).

---

### Task 1: Add the 60s timeout to the RL-03 test

- [ ] **Step 1:** In `test/workit-core/workspaces-scripts.test.ts`, convert `test("pr-create.sh create: target branch flows from config for every preset (RL-03)", () => { ... });` to the `test(name, fn, { timeout: 60_000 })` form, matching the sibling heavy-git test at line 306-348.
- [ ] **Step 2:** Run the focused test locally and confirm it passes with the timeout option.

**Criteria:** Test passes locally; timeout matches the file precedent exactly; assertions byte-identical.

| Status | Task |
| --- | --- |
| pending | 1: Add the 60s timeout to the RL-03 test |

### Task 2: Changelog and verification

- [ ] **Step 1:** Update CHANGELOG.md Unreleased with a `### Fixed` entry: Windows CI flake — RL-03 pr-create target test gets the 60s budget already used by sibling heavy-git tests.
- [ ] **Step 2:** Run `workflow_verify` (lint, format:check, tests, build, changelog) and fix any failures.

**Criteria:** `workflow_verify` passes; changelog entry present; CI (especially the Windows workit-core job) green on the branch.

| Status | Task |
| --- | --- |
| pending | 2: Changelog and verification |
