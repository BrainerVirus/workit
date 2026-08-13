---
name: wk-implement
description: Execute an approved Superpowers plan on Cursor as the coordinator session (inline only). subagent-driven is unsupported on Cursor and the MCP rejects that menu choice. Use for /wk-implement or "implement from plan".
disable-model-invocation: true
---

# Implement

Execute the plan **inline in this coordinator session**. subagent-driven execution is unsupported on Cursor: the MCP rejects the subagent-driven menu choice (`unsupported_mode`) — Cursor has no child sessions. Plan-level edits stay coordinator-gated.

## Step 1 — Gather facts (required)

Call MCP tool `workflow_plan_tasks` with `plan_path` from the user's message and `spec_path` when known.

**Repository calls:** For every repository-scoped `workflow_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

Use the returned `tasks[]` as ground truth. Cache each `section_text` for subagent prompts. Do not read the plan file for task text.

## Step 2 — Load execution contract

Resolve plugin root: `WORKFLOW_TOOLKIT_ROOT` env or `~/.cursor/plugins/local/workit/`.

Load `templates/execution-contract.md`. Substitute `<SPEC_PATH>`, `<PLAN_PATH>`, `<BRANCH>`, `<SDD_DIR>`, `<TASK_LIST>` from MCP. If template missing, stop with error.

## Step 3 — Follow contract

Announce: "Using implement + inline."

**Before Task 1 — validate + SDD + TodoWrite UI + branch (no worktrees):**

0. `workflow_docs_validate` with spec + plan paths — hard-fail before any SDD mutation
1. `workflow_sdd_context` with `plan_path` — cache `sdd_dir`, `completed_task_ids`, **`todos`**
2. **TodoWrite** with `todos` from step 1 (`merge: false`) — required for Cursor native task list UI (SDD is not a UI substitute)
3. `workflow_resolve_branch` with spec + plan paths
4. If `needs_checkout` and `dirty` → native **AskQuestion** asks whether to stash before checkout
5. `workflow_branch_setup` with `target_branch`, `stash`, `sdd_dir` from step 1

Follow the contract verbatim. Keep TodoWrite `in_progress`/`completed` in sync each task. At verify/commit phase use `workflow_verify` and `workflow_git_context` MCP tools.

Do not emit a handoff fence — this is in-session execution.
