---
name: wk-implement
description: Coordinate a tracked Superpowers plan with delegated implementation and reviews.
disable-model-invocation: true
---

# Implement

The parent agent is coordinator-only. It must not edit product code or perform delegated exploration.

## Native setup

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call read-only `workflow_plan_tasks` and `workflow_sdd_context`; their structured results are ground truth.
3. Call `workflow_flow_status` with the plan path and hard-stop unless `spec.status === "approved"`, `plan.status === "approved"`, and `menu.presented === true`. If any gate is missing, run the required approval flow (`workflow_spec_approve`/`workflow_plan_approve` after the user's native-question approval, `workflow_plan_menu` after the post-plan menu) and re-check — never start tasks on a draft or unapproved plan.
4. Initialize native `todowrite` from returned tasks and mark ledger-completed task IDs completed.
5. Call `workflow_resolve_branch`, then show the current branch, target branch, and stash behavior before any branch checkout/setup mutation.
6. Always use native `question` before that mutation. For a clean tree, ask whether to proceed or cancel. For a dirty tree, add the stash choice and state what will be stashed; allow a custom answer.
7. Call `workflow_branch_setup` with `confirmed: true` only after approval; never use worktrees. Flow-tool confirmations are never agent-typed booleans and never caller-supplied evidence: the plugin records your native-`question` answer as a host-observed one-use receipt (`attested: true`, `callID`, `selectedLabel`, `recordedAt`) consumed by the approval/menu tools — no evidence argument exists. Delegated worker status comes from host session parentage (`parentID`), never a caller `role` field.
8. Report any setup failure stage or partial result; never infer success.
9. Fill specs/plans from the quality templates: `templates/spec-template.md` for specs, `templates/plan-template.md` for plans. After `workflow_docs_validate`, surface the returned `quality` findings: hard findings (missing required section, missing CA-XX) block task start unless the user explicitly waives them; warnings are advisory.

Working state lives only in gitignored `docs/<slug>/sdd/` — never `.superpowers/sdd`, never an extra nested slug level. Load the package-neutral execution contract by name, not an installation-specific path.

## Per-task loop

For every plan task whose ID is absent from `completed_task_ids`:

1. Mark it `in_progress` with `todowrite`.
2. Create its brief with `workflow_sdd_task_brief` using `confirmed: true` and the parsed `section_text`.
3. Use `task` with the built-in `explore` agent for read-only discovery when needed, then a fresh built-in `general` agent to implement from the brief. The parent remains coordinator-only.
4. Require product changes to follow TDD: failing check first, minimal implementation, passing focused check.
5. Create the review package with `workflow_sdd_review_package` using `confirmed: true`.
6. Dispatch separate `general` agents for spec-compliance review and code-quality review. **Blocking findings** (Critical, Important, or spec-compliance) may trigger at most **two** fix+re-review rounds per task. **Advisory** findings (Minor, style, YAGNI, taste) never pause the loop — append them to `<SDD_DIR>/advisories.md` with the task id.
7. Append the validated ledger line with `workflow_sdd_append_progress` using `confirmed: true`, then mark the task completed with `todowrite`.

Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.

Never redispatch completed task IDs. Pass task briefs and review diffs to agents; do not make them reparse the plan. Keep commits on the in-place feature/bugfix branch.

## Final gate

After all remaining tasks, dispatch a final full-branch code review, run `workflow_verify`, and report exact per-check results. Present the full `<SDD_DIR>/advisories.md` roll-up once, then use native `question` so the user can choose which advisory items to fix, discuss, or discard. Only then may advisory fixes run. Use `workflow_git_context` for the final commit preview and the `wk-commit` skill for any approved commit. If a tracked stash reference exists, preview reapplication with `question`, then call `workflow_branch_setup` with `confirmed: true` only after approval.
