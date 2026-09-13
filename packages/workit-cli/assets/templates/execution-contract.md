Load resolved method skills through the host skill loader when policy selects them. Implement the existing plan; do not re-plan.

**Spec:** <SPEC_PATH>
**Plan:** <PLAN_PATH>
**Branch:** <BRANCH>

## Hard gates

- Inspect task state before acting. On OpenCode, Cursor, Codex, and Pi use the eight shared `workit_*` families (`workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, `workit_state`). On the CLI host use `workit <family> <action>` with the same actions (hyphenated on the CLI).
- Never use a worktree. Branch changes are in-place through the approved `git.branch_setup` external action (CLI: `workit action git.branch_setup --payload …`).
- Task metadata lives under `.workit/`; never edit it directly. Record progress, evidence, findings, decisions, and worker state only through the shared operations.
- Helpers cannot widen scope, record binding decisions, close or pause the task, assign further helpers, or resolve blockers for the lead.
- On Cursor, pass the active workspace as `workspace_root` on every repository-scoped call.

## Setup

1. If there is no active or paused task, call `workit_task` with `action: "start"` then `workit_policy` with `action: "assess"` (CLI: `workit task start …` then `workit policy assess …`).
2. Load `workit-plan`, list tasks with `workit_task` `action: "list"`, and mirror visible todo state to the host UI.
3. When policy requires a feature branch, resolve it with read-only `context.read` and apply `git.branch_setup` only after native approval.

## Remaining-task loop

For each bounded plan task:

1. Mark the item in progress in the host todo UI and record boundary progress with `workit_task` `action: "progress"`.
2. Route by policy: assign bounded workers with `workit_worker` `action: "assign"` when delegation is available; otherwise implement inline. Acquire product-write ownership with `workit_writer` `action: "acquire"` before repository mutations; release it when done.
3. Record checks and artifacts with `workit_evidence` `action: "record"`. Record review concerns with `workit_finding` `action: "record"`; resolve or defer them with `finding.resolve`. Blocking findings may trigger at most **two** fix+re-review rounds per task; advisory taste/YAGNI items still use `finding.record` and never pause the loop by direct file edit.
4. Never advance while a foreign writer is active or blocking findings remain open for the current candidate.

## Final gate

Run repository verification (CLI: `workit doctor`; hosts: approved project verify when policy requires it). **Mandatory:** close the lead task with `workit_task` `action: "close"` (CLI: `workit task close --payload … [--confirm]`) once requirements are satisfied and verification passes — never finish while the task is still `active` or `paused`.

## Task order

<TASK_LIST>

## Quality gate

- Specs/plans follow `templates/spec-template.md` / `templates/plan-template.md`.
