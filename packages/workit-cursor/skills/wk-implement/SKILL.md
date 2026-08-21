---
name: wk-implement
description: Execute an approved Superpowers plan on Cursor as the coordinator session (inline only). subagent-driven is unsupported on Cursor and the MCP rejects that menu choice. Use for /wk-implement or "implement from plan".
disable-model-invocation: true
---

# Implement

Execute the plan **inline in this coordinator session**. subagent-driven execution is unsupported on Cursor: the MCP rejects the subagent-driven menu choice (`unsupported_mode`) — Cursor has no child sessions. Plan-level edits stay coordinator-gated.

## Step 1 — Gather facts (required)

Call MCP tool `workit_plan_tasks` with `plan_path` from the user's message and `spec_path` when known.

**Repository calls:** For every repository-scoped `workflow_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

Use the returned `tasks[]` as ground truth. Cache each `section_text` for subagent prompts. Do not read the plan file for task text.

## Step 2 — Load execution contract

Resolve plugin root: `WORKFLOW_TOOLKIT_ROOT` env or `~/.cursor/plugins/local/workit/`.

Load `templates/execution-contract.md`. Substitute `<SPEC_PATH>`, `<PLAN_PATH>`, `<BRANCH>`, `<SDD_DIR>`, `<TASK_LIST>` from MCP. OMIT the `## Handoff destination` section and its `<workflow-handoff-destination>` marker line — that section is only for sessions started from a `workit_handoff_prompt` destination prompt. This inline executor is NOT a destination and must never present itself as one (five-choice source menu, Handoff still available). If template missing, stop with error.

## Step 3 — Follow contract

Announce: "Using implement + inline."

**Before Task 1 — validate + SDD + TodoWrite UI + branch (no worktrees):**

0. `workit_docs_validate` with spec + plan paths — hard-fail before any SDD mutation
1. `workit_sdd_context` with `plan_path` — cache `sdd_dir`, `completed_task_ids`, **`todos`**
2. **TodoWrite** with `todos` from step 1 (`merge: false`) — required for Cursor native task list UI (SDD is not a UI substitute)
3. `workit_resolve_branch` with spec + plan paths
4. If `needs_checkout` and `dirty` → native **AskQuestion** asks whether to stash before checkout
5. `workit_branch_setup` with `target_branch`, `stash`, `sdd_dir` from step 1

Follow the contract verbatim. Keep TodoWrite `in_progress`/`completed` in sync each task. At verify/commit phase use `workit_verify` and `workit_git_context` MCP tools.

Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.

Do not emit a handoff fence — this is in-session execution.

**Mandatory:** end the run by calling MCP `workit_plan_complete` after the final task once the SDD ledger is complete (all task IDs appended) and `workit_verify` passes — a complete ledger and green verification are the tool's gates. Never finish the run while the plan is still `active`.
