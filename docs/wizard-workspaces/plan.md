# Wizard Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/wizard-workspaces/spec.md`
**Branch:** `feature/wizard-workspaces`

**Goal:** Workspaces step in the flowkit TUI — add/remove/skip workspace entries writing the core-resolved `workspaces.json`.

## Global Constraints

- The write reuses `workspacesPath()` + the WorkspaceConfig type from `src/core/workspaces.ts` — no schema drift.
- Step index 4 (between VcsStep and ProjectStep); wizard keeps 7 steps total.
- Skip = no write (preserves manual configs).
- Non-TTY tests only for the logic (`writeWorkspaces` add/remove/skip/merge); TTY smoke for the step rendering.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: Workspaces write logic

- [ ] **Step 1:** `src/cli/logic.ts`: `writeWorkspaces(entries: WorkspaceConfig[]): { ok: boolean; error?: string; path: string }` — reads existing via `workspacesPath()` (tolerate missing/malformed → treat as empty), replaces the whole list (the wizard owns the file when used), atomic write (tmp + rename), validates each entry minimally (name + glob required, provider in gitlab|github, no nulls). Also `loadWorkspaces(): WorkspaceConfig[]` (existing → parsed entries; missing/malformed → []).
- [ ] **Step 2:** Tests `test/cli-logic.test.ts` (extend): add-merge replaces the list; remove drops the entry; malformed existing file → treated as empty (no throw); skip = file untouched (no write call); written file resolves via `resolveWorkspace` (parity — CA-02); missing file → loadWorkspaces [].

**Criteria:** CA-02, CA-03, CA-04 (partial — logic level), CA-05.

| Status | Task |
| --- | --- |
| pending | 1: Workspaces write logic |

### Task 2: WorkspacesStep component + wiring

- [ ] **Step 1:** `src/cli/steps.tsx`: `WorkspacesStep` (index 4): loads existing entries (list view), actions: add (text inputs: name, glob; select: provider gitlab/github; text: defaultTargetBranch default "main"; select: issue linking youtrack/github/none) — appends to the in-memory list; remove (select an existing entry to delete); done writes via `writeWorkspaces` (only if changed — if the user made no change, no write, same as skip); skip/exit without changes = no write.
- [ ] **Step 2:** `src/cli/index.tsx`/`steps.tsx` wiring: the step array becomes `[Platform, Config, YouTrack, Vcs, Workspaces, Project, Summary]` (7 steps, Workspaces at index 4); `advance` bound updated (max 6).
- [ ] **Step 3:** TTY smoke: `bun ./src/cli/index.tsx init </dev/null` exits cleanly; the step renders. Non-TTY logic tests from Task 1 cover behavior.

**Criteria:** CA-01, CA-02, CA-04 (end-to-end).

| Status | Task |
| --- | --- |
| pending | 1: Workspaces write logic |
| pending | 2: WorkspacesStep component + wiring |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (schema parity with core, atomic write, skip-preserve, step ordering, TTY safety).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/wizard-workspaces`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: Workspaces write logic |
| pending | 2: WorkspacesStep component + wiring |
| pending | 3: Final gate — review + PR |
