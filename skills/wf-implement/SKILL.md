---
name: wf-implement
description: Coordinate a tracked Superpowers plan with delegated implementation and reviews.
disable-model-invocation: true
---

# Implement

The parent agent is coordinator-only. It must not edit product code or perform delegated exploration.

## Native setup

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call read-only `workflow_plan_tasks` and `workflow_sdd_context`; their structured results are ground truth.
3. Initialize native `todowrite` from returned tasks and mark ledger-completed task IDs completed.
4. Call `workflow_resolve_branch`, then show the current branch, target branch, and stash behavior before any branch checkout/setup mutation.
5. Always use native `question` before that mutation. For a clean tree, ask whether to proceed or cancel. For a dirty tree, add the stash choice and state what will be stashed; allow a custom answer.
6. Call `workflow_branch_setup` with `confirmed: true` only after approval; never use worktrees.
7. Report any setup failure stage or partial result; never infer success.

State lives only in tracked `docs/superpowers/sdd/<slug>/`. Never use an untracked or legacy SDD directory. Load the package-neutral execution contract by name, not an installation-specific path.

## Per-task loop

For every plan task whose ID is absent from `completed_task_ids`:

1. Mark it `in_progress` with `todowrite`.
2. Create its brief with `workflow_sdd_task_brief` using `confirmed: true` and the parsed `section_text`.
3. Use `task` with the built-in `explore` agent for read-only discovery when needed, then a fresh built-in `general` agent to implement from the brief. The parent remains coordinator-only.
4. Require product changes to follow TDD: failing check first, minimal implementation, passing focused check.
5. Create the review package with `workflow_sdd_review_package` using `confirmed: true`.
6. Dispatch separate `general` agents for spec-compliance review and code-quality review. Important, Critical, or spec-compliance findings block the next task; send fixes back to the implementer and repeat both reviews until clean.
7. Append the validated ledger line with `workflow_sdd_append_progress` using `confirmed: true`, then mark the task completed with `todowrite`.

Never redispatch completed task IDs. Pass task briefs and review diffs to agents; do not make them reparse the plan. Keep commits on the in-place feature/bugfix branch.

## Final gate

After all remaining tasks, dispatch a final full-branch code review, run `workflow_verify`, and report exact per-check results. Use `workflow_git_context` for the final commit preview and the `wf-commit` skill for any approved commit. If a tracked stash reference exists, preview reapplication with `question`, then call `workflow_branch_setup` with `confirmed: true` only after approval.
