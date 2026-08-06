Load `using-superpowers`, `subagent-driven-development`, `test-driven-development`, and `verification-before-completion` through OpenCode's `skill` tool. Implement the existing plan; do not re-plan.

**Spec:** <SPEC_PATH>
**Plan:** <PLAN_PATH>
**Branch:** <BRANCH>
**SDD:** `<SDD_DIR>`

## Hard gates

- The parent is coordinator-only: it does not edit product code or perform delegated exploration.
- Never use a worktree. Branch changes are in-place through `workflow_branch_setup` on `feature/*` or `bugfix/*`; never commit on protected branches.
- Tracked state, briefs, ledgers, and review diffs live only under `<SDD_DIR>` in `docs/<slug>/sdd/` and use `workflow_sdd_*` tools.
- Use native `todowrite` for visible task state as well as the tracked ledger.
- Use native `question` for branch/stash choices and guarded external mutations; call mutation tools only after approval with `confirmed: true`.
- Use native `task` with only the built-in `explore` and `general` agents.

## Flow gates (HARD)

- `wf-implement` refuses to run unless the plan is `approved` (flow.json) and the post-plan menu was presented.
- `wf-handoff` refuses to run unless both spec and plan are `approved`.
- Sequence is enforced by tools: `workflow_spec_approve` (×2), `workflow_plan_approve` (×2), `workflow_plan_menu` — never skip a step.

## Setup

0. Call `workflow_docs_validate` with the linked spec/plan paths. Hard-fail on any error before todos or branch setup.
1. Call `workflow_sdd_context` with `<PLAN_PATH>` and initialize `todowrite` from returned tasks.
2. Call `workflow_plan_tasks`; cache each top-level task's `section_text`.
3. Mark IDs in `completed_task_ids` completed and never redispatch them.
4. Call `workflow_resolve_branch`, then show the current branch, target branch, and stash behavior before any in-place checkout/setup mutation.
5. Always use `question`: for a clean tree ask whether to proceed or cancel; for a dirty tree add the stash choice and describe what will be stashed.
6. Call `workflow_branch_setup` with `confirmed: true` only after approval.

## Remaining-task loop

For each top-level task absent from `completed_task_ids`:

1. Mark it `in_progress` with `todowrite`.
2. Create a tracked brief with `workflow_sdd_task_brief` and `confirmed: true`.
3. Delegate read-only discovery, when needed, to an `explore` agent. Delegate implementation to a fresh `general` agent. Product changes follow TDD.
4. Create a tracked diff with `workflow_sdd_review_package` and `confirmed: true`.
5. Delegate spec-compliance review and code-quality review to separate `general` agents.
6. **Blocking** findings (Critical, Important, or spec-compliance) may trigger at most **two** fix+re-review rounds per task. **Advisory** findings (Minor, style, YAGNI, taste) never pause the loop — append them to `<SDD_DIR>/advisories.md`.
7. Append the validated ledger entry with `workflow_sdd_append_progress` and `confirmed: true`; mark the todo completed.

## Final gate

Run a separate full-branch code review, then `workflow_verify`. Present the full `<SDD_DIR>/advisories.md` roll-up once, then use native `question` so the user can choose which advisory items to fix, discuss, or discard. Report exact check results and never infer success. Use `workflow_git_context` for a commit preview and load `wf-commit` through `skill` for an approved commit. If tracked state contains a stash reference, preview reapplication through `question`, then call `workflow_branch_setup` with `confirmed: true` after approval.

## Task order

<TASK_LIST>

## Quality gate (HARD)

- Specs/plans are written from `templates/spec-template.md` / `templates/plan-template.md`.
- After `workflow_docs_validate`, surface `quality` findings. Hard findings (missing required section, missing CA-XX) block task start unless the user explicitly waives them. Warnings are advisory.
