# Rebrand Workit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/rebrand-workit/spec.md`
**Branch:** `feature/rebrand-workit`

**Goal:** Rebrand to workit (core + opencode + cursor + cli packages), monorepo via bun workspaces, wk-* entry points, semantic-release automation, opencode CI review, GitHub repo rename.

## Global Constraints

- Config dir (`~/.config/workflow-toolkit/`) and `WORKFLOW_TOOLKIT_CONFIG*` env vars UNCHANGED (stability — documented in README).
- No git history rewrite; repo rename via GitHub settings + remote URL update.
- Conventional Commits from now on (semantic-release depends on it).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: Monorepo restructure — core + opencode + cursor + cli (already shipped as packages/workit + workit-cli; EXTENDS to 4 packages)

- [ ] **Step 1 (DONE, commits 63e396c/6c01844):** created `packages/workit` + `packages/workit-cli`; wk-* renames; references; file:// pin + FATAL verification; 431 tests green.
- [ ] **Step 2 (NEW — the 4-package split):** restructure `packages/workit` into `packages/workit-core` (skills/, commands/, vendor/, templates/, scripts/ + src/core + src/tools — `@brainervirus/workit-core`), `packages/workit-opencode` (src/plugin.ts + hooks — `@brainervirus/workit-opencode`, thin over the core), `packages/workit-cursor` (cursor/ dir + mcp + hooks + rules + marketplace manifest — `@brainervirus/workit-cursor`), `packages/workit-cli` (unchanged). Update plugin.ts root resolution (skills/commands/vendor now live in the core package), the cursor run-server.sh/server.ts imports, tests' import paths, and the grep gates. publishConfig public on all four.
- [ ] **Step 3:** Verify: `bun install` resolves all four; `bun run check` green; `npm pack --dry-run` per package sane (core largest, opencode/cursor/cli thin).

**Criteria:** CA-01, CA-02, CA-03, CA-04, CA-05, CA-06.

| Status | Task |
| --- | --- |
| pending | 1: Monorepo restructure + package rename |

### Task 2: GitHub repo rename + semantic-release + opencode CI review

- [ ] **Step 1 (DONE, staged):** semantic-release config (release.config.cjs) + workflow + README/CONTRIBUTING URL updates (commit on the coordinator's confirmation); opencode-review.yml created with the pull_request review flow.
- [ ] **Step 2 (NEW — model + flows):** update opencode-review.yml + any new opencode workflows (issue_comment /oc flows, issues triage) to use `model: opencode-go/deepseek-v4-flash` (verified on models.dev — the user's plan); prompts follow the docs examples (https://opencode.ai/docs/github/) enforcing workit's own standards (the enforcement rails as review criteria). Decide BLOCKING vs ADVISORY per flow: pull_request review = required check (blocks merge); /oc comment flows = advisory (on-demand). Document the decision per flow in the workflow comments.
- [ ] **Step 3:** GitHub repo renamed `workflow-toolkit` → `workit` (coordinator runs `gh api repos/BrainerVirus/workflow-toolkit -X PATCH -f name=workit` post-merge, then `git remote set-url origin`); README badges/URLs use the new name (CA-07 grep gate).
- [ ] **Step 4:** Auto-update documented in README: opencode does NOT auto-update npm plugins (pinned version until the pin changes — ponytail evidence); workit consumers pin `latest` (re-resolved on restart) or use the existing `sync-runtime.sh` for dev (G9b).

**Criteria:** CA-07, CA-08, CA-10.

| Status | Task |
| --- | --- |
| pending | 1: Monorepo restructure + package rename |
| pending | 2: GitHub repo rename + semantic-release |

### Task 3: Release v0.4.0 + Bugbot activation note

- [ ] **Step 1:** First release under the new names: semantic-release (or manual tag if the automation isn't ready) publishes `@brainervirus/workit` + `@brainervirus/workit-cli`; `npm view` both resolve (CA-09).
- [ ] **Step 2:** Final gate — subagent review of the whole branch diff (monorepo wiring, rename completeness, semantic-release config, grep gates green).
- [ ] **Step 3:** Apply review fixes if any; `bun run check`; push; PR; CI (3 OS); merge; then the coordinator performs the GitHub repo rename + remote URL fix.

**Criteria:** CA-09 + review findings addressed; CI pass on all 3 OS; PR merged; repo renamed.

| Status | Task |
| --- | --- |
| pending | 1: Monorepo restructure + package rename |
| pending | 2: GitHub repo rename + semantic-release |
| pending | 3: Release v0.4.0 + Bugbot activation note |
