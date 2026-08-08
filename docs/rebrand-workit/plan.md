# Rebrand Workit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/rebrand-workit/spec.md`
**Branch:** `feature/rebrand-workit`

**Goal:** Rebrand to workit (@brainervirus/workit + @brainervirus/workit-cli), monorepo via bun workspaces, wk-* entry points, semantic-release automation, GitHub repo rename.

## Global Constraints

- Config dir (`~/.config/workflow-toolkit/`) and `WORKFLOW_TOOLKIT_CONFIG*` env vars UNCHANGED (stability — documented in README).
- No git history rewrite; repo rename via GitHub settings + remote URL update.
- Conventional Commits from now on (semantic-release depends on it).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: Monorepo restructure + package rename

- [ ] **Step 1:** Create `packages/workit/` and `packages/workit-cli/` (bun workspaces): move src/, skills/, commands/, cursor/, templates/, scripts/ into `packages/workit/`; move src/cli/ + the Ink deps into `packages/workit-cli/` (its own package.json: `@brainervirus/workit-cli`, bin `workit`, deps ink/react/@inkjs/ui). Root package.json becomes the workspace root (workspaces: ["packages/*"], scripts delegating to both).
- [ ] **Step 2:** Rename identities: `@brainervirus/workit` (core, public access, bin removed — the CLI is the cli package) and `@brainervirus/workit-cli` (bin `workit`). Update descriptions/keywords.
- [ ] **Step 3:** 12 skills + 12 commands `wf-*` → `wk-*` (file names, YAML names, plugin descriptions, cursor registration); grep gate test updated (CA-02 pattern: zero `wf-` entry-point references).
- [ ] **Step 4:** Update all `workflow-toolkit`/`wf-` references in src/, README, CONTRIBUTING, templates, cursor plugin (G4/G5); run-server.sh fallback `~/.local/share/workflow-toolkit` → documented (config stability: keep the share path OR document the alias — decide with a comment).
- [ ] **Step 5:** Verify: `bun install` at root resolves both packages; `bun run check` green; `npm pack --dry-run` per package sane.

**Criteria:** CA-01, CA-02, CA-03, CA-04, CA-05, CA-06.

| Status | Task |
| --- | --- |
| pending | 1: Monorepo restructure + package rename |

### Task 2: GitHub repo rename + semantic-release

- [ ] **Step 1:** GitHub repo renamed `workflow-toolkit` → `workit` (via gh api or GitHub settings — the coordinator runs the rename after the branch merges OR the user does it; document the exact steps); update `git remote set-url origin`; update README badges/URLs (CA-07 grep gate).
- [ ] **Step 2:** Add semantic-release: `release.config.js` (Conventional Commits, branches [main], plugins: commit-analyzer, release-notes-generator, npm (both packages in order: workit then workit-cli), github); replace release.yml's manual flow with the semantic-release workflow (GITHUB_TOKEN + NPM_TOKEN secrets); add a `semantic-release` dry-run verification (CA-08).
- [ ] **Step 3:** Add the opencode review workflow `.github/workflows/opencode-review.yml` (pull_request event: opened/synchronize/reopened/ready_for_review; `anomalyco/opencode/github@latest` with the review prompt from opencode.ai/docs/github — permissions read-only, `use_github_token: true`); README documents it + registers it as a required check in branch protection (the coordinator runs `gh api` after merge) + Bugbot as optional alternative (CA-10).

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
