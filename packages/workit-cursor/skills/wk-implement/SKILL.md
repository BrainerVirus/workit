---
name: wk-implement
description: Execute an approved Superpowers plan on Cursor as the coordinator session in either approved execution mode. Subagent-driven dispatches Cursor-native subagents through a lease/token capability; Inline executes every task in this session. Use for /wk-implement or "implement from plan".
disable-model-invocation: true
---

# Implement

Execute the plan in the **approved execution mode** recorded by `workit_plan_menu` (call `workit_flow_status` to read it). Both modes stay coordinator-gated: this session never edits product code — Subagent-driven dispatches Cursor-native subagents, Inline does every task itself. Plan-level edits stay coordinator-gated.

## Step 1 — Gather facts (required)

Call MCP tool `workit_plan_tasks` with `plan_path` from the user's message and `spec_path` when known.

**Repository calls:** For every repository-scoped `workit_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

Use the returned `tasks[]` as ground truth. Cache each `section_text` for subagent prompts. Do not read the plan file for task text.

## Step 2 — Load execution contract

Resolve plugin root: `WORKFLOW_TOOLKIT_ROOT` env or `~/.cursor/plugins/local/workit/`.

Load `templates/execution-contract.md`. Substitute `<SPEC_PATH>`, `<PLAN_PATH>`, `<BRANCH>`, `<SDD_DIR>`, `<TASK_LIST>` from MCP. OMIT the `## Handoff destination` section and its `<workflow-handoff-destination>` marker line — that section is only for sessions started from a `workit_handoff_prompt` destination prompt. This inline executor is NOT a destination and must never present itself as one (five-choice source menu, Handoff still available). If template missing, stop with error.

## Step 3 — Route by execution mode

Announce: "Using implement + <mode>."

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

### Subagent-driven

Requires the flow's execution mode `subagent-driven` (set by `workit_plan_menu`).

1. `workit_plan_menu` returned the raw **`coordinator_lease`** exactly once — use that stored value; the flow state persists only its hash.
2. Per task: call MCP `workit_delegate` with `{slug, plan_path, task_id, coordinator_lease, workspace_root}` to mint a task-scoped **`delegation_token`**.
3. Dispatch a Cursor-native subagent whose prompt includes the task brief and the raw `delegation_token`; the worker passes it as `delegation_token` on its mutation calls (`workit_sdd_task_brief`, `workit_sdd_review_package`, `workit_sdd_append_progress`, `workit_branch_setup`, `workit_pr_create`, …). The MCP validates the token against the flow state and fails closed on invalid, wrong-task, wrong-workspace, or revoked tokens.
4. Coordinator product edits stay blocked — implementation, reviews, and fix rounds happen in the dispatched subagents.
5. Appending the task's progress line with `workit_sdd_append_progress` revokes that task's token; mint a fresh token per task.

### Inline

Load and follow `executing-plans` in the current session. Every task runs in this agent — single-agent, no dispatch, no token minting.

**Mandatory:** end the run by calling MCP `workit_plan_complete` after the final task once the SDD ledger is complete (all task IDs appended) and `workit_verify` passes — a complete ledger and green verification are the tool's gates. Never finish the run while the plan is still `active`.
