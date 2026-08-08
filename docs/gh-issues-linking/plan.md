# GitHub Issues Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/gh-issues-linking/spec.md`
**Branch:** `feature/gh-issues-linking`

**Goal:** GitHub-side PR↔issue linking: config.sh recognizes `issues: { provider: "github" }`, pr-create supports `Closes #n`/`Related to #n`, and wf-pr asks a three-option question when no issue is derivable.

## Global Constraints

- Reuse the vcs-workspaces machinery: `issues_provider`/`link_on_pr` flow through config.sh resolve/load exactly like youtrack fields; the CLI guard stays the single missing-`gh` path.
- Env contract: `WORKFLOW_GH_ISSUE` (number or `#42`) + `WORKFLOW_GH_ISSUE_RELATION` (`closes` default / `related`).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: config.sh + pr-create github issue support

- [ ] **Step 1:** `scripts/vcs/config.sh` resolve: recognize `issues: { provider: "github", link_on_pr }` from the matched workspace — output keys `issues_provider`, `link_on_pr` (github path); youtrack keys stay null for github workspaces; work workspace unchanged (youtrack.link_issues still flows). load merges them like the other workspace keys.
- [ ] **Step 2:** `scripts/pr-create.sh` github path: read `WORKFLOW_GH_ISSUE` (strip leading `#`) + `WORKFLOW_GH_ISSUE_RELATION`; when set → body line `Closes #<n>` (relation closes, default) or `Related to #<n> — https://github.com/<owner>/<repo>/issues/<n>` (related; owner/repo from `git remote get-url origin` parsed). When unset → derive from the branch: `feature/42-title` → `Closes #42` (pure-number regex `(?:^|/|-)(\d+)\b`), no question needed. Else → no line.
- [ ] **Step 3:** Tests (extend test/workspaces-scripts.test.ts + a github-case file if cleaner): resolve returns issues_provider github + link_on_pr for a github workspace; pr-create body with WORKFLOW_GH_ISSUE=42 closes → `Closes #42`; related → `Related to #42` + URL; branch feature/42-title → auto closes; branch feature/foo → no line; work workspace youtrack flow unchanged (existing tests stay green).

**Criteria:** CA-01, CA-02, CA-03.

| Status | Task |
| --- | --- |
| pending | 1: config.sh + pr-create github issue support |

### Task 2: wf-pr skill flow — three-option question

- [ ] **Step 1:** `skills/wf-pr/SKILL.md`: add the github+link_on_pr flow: when the resolved workspace is github with link_on_pr and no issue is derivable (no env, no branch number), ask with native `question` — exactly three options: (1) use an existing issue (user provides the number/URL — verify with `gh issue view`), (2) create a new issue via `gh issue create --title ... --body ...` (reuse the CLI guard; on success pass the returned number), (3) skip linking (no line). Then pass `WORKFLOW_GH_ISSUE` (+ `WORKFLOW_GH_ISSUE_RELATION` when the PR does not resolve the issue) to pr-create.
- [ ] **Step 2:** If a `commands/wf-pr.md` template or reminder text exists for wf-pr, mirror the three-option rule there; otherwise the skill is the single source.

**Criteria:** CA-04.

| Status | Task |
| --- | --- |
| pending | 1: config.sh + pr-create github issue support |
| pending | 2: wf-pr skill flow — three-option question |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (config.sh parity, body-line formats, branch regex, skill wording with exactly 3 options, CLI-guard reuse).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/gh-issues-linking`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: config.sh + pr-create github issue support |
| pending | 2: wf-pr skill flow — three-option question |
| pending | 3: Final gate — review + PR |
