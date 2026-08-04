---
name: wf-implement
description: Execute a Superpowers plan as SDD coordinator with subagent-per-task and mandatory review loops. Use for /wf-implement or "implement from plan using subagent-driven-development".
disable-model-invocation: true
---

# Implement

Execute a plan as **coordinator only** (subagent-driven-development). Do not edit product code in this thread.

## Step 1 — Gather facts (required)

Call MCP tool `workflow_plan_tasks` with `plan_path` from the user's message and `spec_path` when known.

**Workspace root:** defaults to the Cursor workspace. Pass `workspace_root` when plan/spec paths are relative to a different repository.

Use the returned `tasks[]` as ground truth. Cache each `section_text` for subagent prompts. Do not read the plan file for task text.

## Step 2 — Load execution contract

Resolve plugin root: `WORKFLOW_TOOLKIT_ROOT` env or `~/.cursor/plugins/local/workflow-toolkit/`.

Load `templates/execution-contract.md`. Substitute `<SPEC_PATH>`, `<PLAN_PATH>`, `<BRANCH>`, `<SDD_DIR>`, `<TASK_LIST>` from MCP. If template missing, stop with error.

## Step 3 — Follow contract

Announce: "Using implement + subagent-driven-development."

**Before Task 1 — validate + SDD + TodoWrite UI + branch (no worktrees):**

0. `workflow_docs_validate` with spec + plan paths — hard-fail before any SDD mutation
1. `workflow_sdd_context` with `plan_path` — cache `sdd_dir`, `completed_task_ids`, **`todos`**
2. **TodoWrite** with `todos` from step 1 (`merge: false`) — required for Cursor native task list UI (SDD is not a UI substitute)
3. `workflow_resolve_branch` with spec + plan paths
4. If `needs_checkout` and `dirty` → native **AskQuestion** asks whether to stash before checkout
5. `workflow_branch_setup` with `target_branch`, `stash`, `sdd_dir` from step 1

Follow the contract verbatim. Keep TodoWrite `in_progress`/`completed` in sync each task. At verify/commit phase use `workflow_verify` and `workflow_git_context` MCP tools.

Do not emit a handoff fence — this is in-session execution.
