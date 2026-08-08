# VCS Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/vcs-workspaces/spec.md`
**Branch:** `feature/vcs-workspaces`

**Goal:** Path-based workspaces (glob → provider/issue config) with a missing-CLI guard and optional PR↔issue linking.

## Global Constraints

- `workspaces.json` lives in `configDir()` (same env chain as vcs.json: WORKFLOW_TOOLKIT_CONFIG → WORKFLOW_TOOLKIT_CONFIG_DIR → XDG).
- `config.sh` stays the single entry point for scripts — the workspace resolution is injected there so bash/python and TS agree.
- Token storage unchanged (per-provider token files, 0600 on POSIX).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: workspaces resolution core

- [ ] **Step 1:** New `src/core/workspaces.ts`: `resolveWorkspace(cwd: string): { name: string; vcs?: { provider: "gitlab"|"github"; defaultTargetBranch?: string }; youtrack?: { baseUrl?: string; link_issues?: boolean } } | null` — reads `configDir()/workspaces.json` (`{ workspaces: [{ glob, vcs?, youtrack? }] }`), matches cwd against each `glob` in order (use a tiny glob matcher — minimatch-style on `*`/`**`, or reuse any existing matcher in the repo — check first), returns the first match; malformed/missing file or no match → null (never throws). Export the workspaces path helper.
- [ ] **Step 2:** TS surface: `workflow_toolkit_status`/`initStatus` (or a new read-only `workflow_vcs_status` if cheap) reports the resolved workspace for the current directory (name + provider) and the workspaces.json path. Minimal: extend the existing status output, don't add a new tool unless the tests demand it.
- [ ] **Step 3:** Tests `test/workspaces.test.ts`: glob match first-wins; no match → null; malformed/missing file → null no throw; `**` deep match on a nested path; provider/defaultTargetBranch/link_issues from the matched workspace.

**Criteria:** CA-01.

| Status | Task |
| --- | --- |
| pending | 1: workspaces resolution core |

### Task 2: config.sh + pr scripts use resolved workspace + missing-CLI guard

- [ ] **Step 1:** `scripts/vcs/config.sh`: add a `resolve` path (or extend `load`): reads `workspaces.json`, resolves the workspace for the given cwd (passed as env `WORKFLOW_WORKSPACE_ROOT` or arg), and returns `{ provider, defaultTargetBranch, link_issues, youtrack_base_url, workspace_name }` with the global `vcs.json` as fallback. Both bash and python sides of the script.
- [ ] **Step 2:** `scripts/pr-ready-context.sh`: VCS Config section now includes `workspace: <name|none>` + resolved provider (from config.sh).
- [ ] **Step 3:** `scripts/pr-create.sh`: use the resolved provider/defaultTargetBranch from config.sh; add a missing-CLI guard before invoking `gh`/`glab`: detect with `command -v gh`/`command -v glab`; on missing, print the structured error: `workflow CLI missing: <gh|glab> (required for <provider>). Install: <official URL>` and exit non-zero with a machine-readable marker (e.g. `"cli_missing": true`) — GitHub CLI: https://cli.github.com, glab: https://gitlab.com/gitlab-org/cli (or https://github.com/profclems/glab — verify the official one).
- [ ] **Step 4:** Tests: config.sh resolve with a temp workspaces.json (work path → gitlab, personal path → github, no match → global fallback); pr-create missing-CLI path returns the structured error (simulate by PATH without gh/glab or a `command -v` stub).

**Criteria:** CA-02, CA-03.

| Status | Task |
| --- | --- |
| pending | 1: workspaces resolution core |
| pending | 2: config.sh + pr scripts use resolved workspace + missing-CLI guard |

### Task 3: PR ↔ issue linking

- [ ] **Step 1:** `scripts/pr-create.sh`: when the resolved workspace has `link_issues: true` and an issue id is derivable — from the branch name (`feature/IRP-123-*`, `bugfix/NSAT-9-*` — regex `^[A-Z]+-\d+` on the branch) or explicit `WORKFLOW_YT_ISSUE` env — append `Related to: <baseUrl>/issue/<id>` to the PR body (baseUrl from the workspace youtrack or the global youtrack.json). GitLab: `glab mr create` body; GitHub: `gh pr create --body`. Empty id or link_issues false → no line.
- [ ] **Step 2:** Tests: branch-derived id → body contains the Related-to line with the right URL; link_issues false → no line; explicit env override wins.

**Criteria:** CA-04.

| Status | Task |
| --- | --- |
| pending | 1: workspaces resolution core |
| pending | 2: config.sh + pr scripts use resolved workspace + missing-CLI guard |
| pending | 3: PR ↔ issue linking |

### Task 4: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (glob matching, env chain, config.sh parity bash/python, missing-CLI error shape, issue-link derivation).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/vcs-workspaces`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: workspaces resolution core |
| pending | 2: config.sh + pr scripts use resolved workspace + missing-CLI guard |
| pending | 3: PR ↔ issue linking |
| pending | 4: Final gate — review + PR |
