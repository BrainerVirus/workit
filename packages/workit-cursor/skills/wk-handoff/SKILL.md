---
name: wk-handoff
description: Emit copy-paste implementation prompt for a new chat via workflow_handoff_prompt. Explicit /wk-handoff only.
disable-model-invocation: true
---

# Handoff

Emit a copy-paste prompt for a **new** implementation chat.

## Step 1 — Gather facts (required)

Call MCP tool `workflow_handoff_prompt` with the **full** user message as `message`.

**Repository calls:** For every repository-scoped `workflow_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

**Thread context:** If this thread has a known spec/plan pair (from brainstorming, writing-plans, or open files), append both paths to `message` even when the user only typed `/wk-handoff`. Without explicit paths, the tool picks the **most recently touched** linked pair under `docs/<slug>/` (plan `**Spec:**` link + file mtimes) — not “only one file in the folder.”

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

The pasted prompt includes instructions to call `workflow_sdd_context`, **Cursor TodoWrite** (with returned `todos`), and `workflow_plan_tasks` in Chat B before Task 1. SDD artifacts go to `docs/<slug>/sdd/` — never `.superpowers/sdd`. TodoWrite is required for the native Cursor task list UI (remaining/completed); the SDD ledger is persistence only. The fenced `prompt` does not contain `section_text`. **Branch** is resolved automatically in the prompt (from spec/plan or derived as `feature/*` / `bugfix/*`). **No worktrees** — Chat B uses `workflow_resolve_branch` + `workflow_branch_setup` in-place. Commits use workit **/wk-commit** skill — no separate commit-policy field.

`workflow_handoff_prompt` also returns `tasks[]`, `branch`, `sdd_dir`, `completed_task_ids`, and `todos` for same-session MCP use — not copy-paste transport.

A destination run that executes the plan must still end with `workflow_plan_complete` once the SDD ledger is complete and repository verification passes.

## Output (success)

When the tool returns `{ prompt }`, output **only** one fenced code block containing `prompt` verbatim. No preamble, no explanation outside the fence.

## Output (failure)

When the tool returns `{ error }` (and optional `candidates`):

- Plain text only — **no fenced block**
- State the error clearly
- If multiple specs or plans exist, list candidate paths from `candidates`
- Instruct the user to re-run with explicit paths in the message:

```text
/wk-handoff
docs/my-feature/spec.md
docs/my-feature/plan.md
```

Example:

```text
Could not resolve spec and plan. Mention both paths in your message, or ensure the newest plan links to its spec via **Spec:**.
Re-run with paths from this thread, e.g.:
/wk-handoff
docs/<slug>/spec.md
docs/<slug>/plan.md
```
