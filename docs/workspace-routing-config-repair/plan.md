# Workspace Routing Config Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workspace-routing-config-repair/spec.md`
**Branch:** `feature/workspace-routing-config-repair`

**Goal:** Finalize the two-workspace routing in the active config, make GitHub PR creation push before create and accept default-equal targets, then clean the legacy config after verification.

## Global Constraints

- No production code without a failing test first (TDD rail).
- Core logic stays in `packages/workit-core/src/core/`; adapters (OpenCode tool, CLI port) only map surfaces to it.
- Parity: identical outcomes through core, the OpenCode `workflow_pr_create` wrapper, and the CLI port, proven by tests.
- No worktrees; in-place branch `feature/workspace-routing-config-repair` (already created).
- Local user config files under `~/.config/workit/` are touched only via the workflow init/config tools or documented edits; never commit them.
- Docs, AGENTS.md, and CHANGELOG Unreleased updated in the same change (parity rule 3).
- Cursor Marketplace pin `@brainervirus/workit-cursor@0.8.0` is never weakened; no Marketplace claims.

---

### Task 1: Active config routing finalization

- [ ] **Step 1:** Assert the current active `~/.config/workit/` state: `workspaces.json` declares exactly `work` (GitLab, `defaultTargetBranch: develop`, gitflow policy) and `personal` (GitHub, `defaultTargetBranch: main`, github-flow policy, `issues.link_on_pr`); `vcs.json` has no `defaultTargetBranch`; `youtrack.json` `tokenFile` is inside the active config dir; tokens exist in the active dir.
- [ ] **Step 2:** Repair any divergence in the active config files so the state matches the spec's CA-01..CA-03 contract (this is a documented, verified local edit — not a repo change).
- [ ] **Step 3:** Add regression tests proving `resolveWorkspace` maps `/work/**` → GitLab/develop/gitflow and `/personal/**` → GitHub/main/github-flow and that no global `defaultTargetBranch` can shadow a workspace policy (extend `test/workit-core/workspaces.test.ts` and `test/workit-core/branch-policy.test.ts`).
- [ ] **Step 4:** Assert the YouTrack config read resolves the token file inside the active config dir only.

**Criteria:** New tests fail before the fix and pass after; `resolveWorkspace` and policy resolution agree for both workspace globs; no active config path references the legacy dir.

| Status | Task |
| --- | --- |
| pending | 1: Active config routing finalization |

### Task 2: GitHub push-before-create honoring pushBranch

- [ ] **Step 1:** Write a failing test in `test/workit-core/pr-create.test.ts` (core path, stubbed `gh` + real local git repo): with `pushBranch` enabled, `prCreate` runs `git push -u origin <branch>` before `gh pr create` and the invoked `gh` args show the pushed branch; with `pushBranch: false` no push runs.
- [ ] **Step 2:** In `packages/workit-core/src/core/pr-create.ts`, before the GitHub `gh pr create` invocation, when `provider === "github"` and `push` is true, spawn `git push -u origin <branch>`; on nonzero exit return a structured `push failed` result without invoking `gh`. Keep the GitLab `--push` path unchanged.
- [ ] **Step 3:** Add parity assertions that both providers push exactly once before create when enabled, through core and the OpenCode wrapper (`createRepoTools().workflow_pr_create.execute`).
- [ ] **Step 4:** Assert the CLI port (`packages/workit-core/src/core/ports/pr-create.ts`) reaches the same core behavior.

**Criteria:** The failing push tests pass; GitLab tests unchanged; no `gh pr create` runs for an unpushed branch when `pushBranch` is enabled.

| Status | Task |
| --- | --- |
| pending | 2: GitHub push-before-create honoring pushBranch |

### Task 3: Default-equal target override acceptance

- [ ] **Step 1:** Write failing tests in `test/workit-core/pr-create.test.ts`: a caller-supplied `WF_PR_TARGET` equal to the resolved workspace default (`main` under github-flow, `develop` under gitflow) is accepted even though protected; a target differing from the default that is protected or disallowed is still rejected; the OpenCode wrapper passes `target_branch` through with the same outcome.
- [ ] **Step 2:** In `packages/workit-core/src/core/pr-create.ts`, compute the resolved default target first; when `targetOverride` equals the default, treat it as authoritative (skip the protected/allowed override validation); genuine differing overrides keep the strict validation.
- [ ] **Step 3:** Add a parity test through the CLI port asserting identical accept/reject outcomes for default-equal and genuine-override targets.

**Criteria:** Default-equal targets accepted on both github-flow (main) and gitflow (develop); genuine overrides still rejected; existing B1 validation tests keep passing.

| Status | Task |
| --- | --- |
| pending | 3: Default-equal target override acceptance |

### Task 4: Legacy config cleanup after verification

- [ ] **Step 1:** Run `workflow_toolkit_status` and the config-guard checks; confirm every active item (youtrack config+token, vcs config, gitlab/github tokens) is `ok` from the active dir alone.
- [ ] **Step 2:** Confirm no active config file references a legacy path, then delete the legacy `~/.config/workflow-toolkit/` non-secret config files: `config.json`, `vcs.json`, `youtrack.json`, `workspaces.json`, and the `templates/` dir (tokens were already removed in the PR #43 session).
- [ ] **Step 3:** Re-run `workflow_toolkit_status` to prove health is unaffected with only the active config present; add/keep a regression note in the doctor tests that the active dir alone is authoritative (extend `test/workit-core/config-guard.test.ts` if needed).

**Criteria:** Cleanup runs only after status is fully green; status stays green after deletion; no doctor/config test depends on the legacy dir.

| Status | Task |
| --- | --- |
| pending | 4: Legacy config cleanup after verification |

### Task 5: Documentation and changelog

- [ ] **Step 1:** Update README and `AGENTS.md`: two-workspace routing (work → GitLab/develop/gitflow, personal → GitHub/main/github-flow), the removed global default, GitHub push-before-create, default-equal target acceptance, and legacy cleanup.
- [ ] **Step 2:** Update CHANGELOG.md Unreleased with a `### Changed`/`### Fixed` entry covering routing, push-before-create, target equality, and legacy cleanup.

**Criteria:** `workflow_verify` changelog check passes; docs state the behavior without claiming Marketplace publication.

| Status | Task |
| --- | --- |
| pending | 5: Documentation and changelog |

### Task 6: Full verification

- [ ] **Step 1:** Run `workflow_verify` (lint, format:check, tests, build, changelog) and fix any failures introduced by this feature.
- [ ] **Step 2:** Re-run the focused parity suites (`pr-create.test.ts`, `workspaces.test.ts`, `branch-policy.test.ts`, `config-guard.test.ts`) and confirm all pass.

**Criteria:** `workflow_verify` passes (the known intermittent TTY flake `Back preserves the draft values entered so far`, when it occurs, is pre-existing and passes in isolation).

| Status | Task |
| --- | --- |
| pending | 6: Full verification |
