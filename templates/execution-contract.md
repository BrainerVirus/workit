/using-superpowers

Load the REQUIRED Superpowers skills listed below by name (in addition to using-superpowers).

Implement the plan below. Do not re-plan.

**Spec:** <SPEC_PATH>
**Plan:** <PLAN_PATH>
**Branch:** <BRANCH>
**SDD:** `<SDD_DIR>` (tracked — use MCP `workflow_sdd_context` only)

## FORBIDDEN — no worktrees

- **NEVER** invoke `using-git-worktrees` or any `git worktree` command.
- Branch changes are **in-place checkout only** via MCP `workflow_branch_setup`.
- Allowed branches: `feature/*` and `bugfix/*` only. Never commit on `main`, `develop`, `master`, or `prod`.

## FORBIDDEN — SDD path

- **NEVER** read or write `.superpowers/sdd/` or run Superpowers `sdd-workspace` script.
- **NEVER** `cat .superpowers/sdd/progress.md` — empty/missing ledger there is NOT ground truth.
- **ALWAYS** use MCP `workflow_sdd_context` with `plan_path: <PLAN_PATH>` — creates `<SDD_DIR>` on fresh projects.
- Progress ledger, briefs, review diffs → **only** under `<SDD_DIR>` via `workflow_sdd_*` tools.

## REQUIRED — Cursor TodoWrite UI

SDD ledger = persistence. **TodoWrite = native Cursor task list UI.** Both are mandatory.

- After `workflow_sdd_context`, **immediately** call Cursor **TodoWrite** with the returned `todos` array (`merge: false`).
- Do **not** skip TodoWrite because SDD exists — the user must see remaining/completed tasks in the UI.
- Before dispatching a task: set that todo `in_progress` (`merge: true`).
- After `workflow_sdd_append_progress` for that task: set todo `completed`; set next remaining todo `in_progress`.
- Todo ids are `task-N` matching plan task ids.

## REQUIRED Superpowers skills

**Load `subagent-driven-development` first.** You are the COORDINATOR — not an implementer.

1. **subagent-driven-development** — Follow exactly: fresh subagent per task, two-stage review after each task, review loops until clean.
2. **test-driven-development** — Implementer subagents follow TDD when the task says so.
3. **verification-before-completion** — Before claiming the plan complete.

## Coordinator setup (once, before Task 1)

1. **SDD workspace (required, even on fresh projects):** Call MCP `workflow_sdd_context` with `plan_path: <PLAN_PATH>`. Cache `sdd_dir`, `progress_path`, `completed_task_ids`, **`todos`**.
2. **Cursor TodoWrite (required for UI):** Call TodoWrite with `todos` from step 1, `merge: false`. Skip only if `todos` is empty (tool error — fix before continuing).
3. **Call MCP `workflow_plan_tasks`** with `plan_path: <PLAN_PATH>`. Cache `tasks[]` — ground truth for `section_text`.
4. **Branch setup (in-place, tools only):**
   - Call MCP `workflow_resolve_branch` with `spec_path` + `plan_path`.
   - If `needs_checkout: true` and `dirty: true` → native **AskQuestion** asks whether to stash → on yes: `workflow_branch_setup` with `target_branch`, `stash: yes`, `sdd_dir: <SDD_DIR>`; on no: stop.
   - If `needs_checkout: true` and `dirty: false` → `workflow_branch_setup` with `stash: no`, `sdd_dir: <SDD_DIR>`.
   - If `needs_checkout: false` → stay on current branch.
5. Pass task content via `workflow_sdd_task_brief` → `brief_path` to subagents. **Subagents must not read the plan file.**

## COORDINATOR HARD-GATES

- Do NOT edit product code in this thread (globs: src/**, lib/**, app/**, packages/**, mcp/**, scripts/**).
- Do NOT implement tasks yourself — Task tool → implementer subagent with `brief_path` + relevant spec excerpt.
- Do NOT explore unfamiliar code yourself — Task tool → explore subagent (readonly).
- Do NOT skip spec-compliance or code-quality reviewer subagents.
- Do NOT proceed while spec compliance is ❌ or any **Critical** / **Important** code issue is open.
- Do NOT use worktrees — `workflow_branch_setup` only.
- Do NOT use `.superpowers/sdd` — `workflow_sdd_*` only.
- Do NOT skip TodoWrite — Cursor UI task tracking is required alongside SDD.

## Per-task loop (every task in MCP tasks[] not in completed_task_ids)

1. **TodoWrite** — set current task `in_progress` (`merge: true`).
2. **Brief** — `workflow_sdd_task_brief` with `sdd_dir`, `task_id`, `section_text` from `workflow_plan_tasks`.
3. **Implementer** — Task tool with `brief_path` from tool (not plan file). Commits: **/wf-commit** (MCP `workflow_git_context` first).
4. **Review package** — `workflow_sdd_review_package` with `base_sha` / `head_sha` → dispatch reviewers with `diff_path` from tool.
5. **Spec compliance review** — loop until ✅.
6. **Code quality review** — loop until no Critical/Important.
7. **Progress** — `workflow_sdd_append_progress` with validated ledger line; TodoWrite mark current `completed` and next remaining `in_progress`.
8. **Next task.**

## After all tasks

1. Final `code-reviewer` pass on full branch delta (requesting-code-review pattern).
2. **finishing-a-development-branch** skill.
3. workflow-toolkit **/wf-verify** then **/wf-commit** (commit skill, MCP-first).
4. If `<SDD_DIR>/manifest.json` has `stash_ref` → native **AskQuestion** asks whether to reapply it → on yes: `workflow_branch_setup` action=`reapply_stash`, `sdd_dir: <SDD_DIR>`.

## Task order (top-level only)

<TASK_LIST>

Start with Task 1. Do not re-plan.
