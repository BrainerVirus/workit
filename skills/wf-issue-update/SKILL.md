---
name: wf-issue-update
description: Draft and post ES-CL YouTrack task update with time tracking via MCP only. Use /wf-issue-update.
disable-model-invocation: true
---

# Issue Update — time + ES-CL comment

Post a Spanish comment and log time on a **task** issue (not the meeting issue).

**Agent language:** English unless the user writes in another language. **Comment body:** Spanish (`es-CL`) only.

**Style contract:** Read [references/youtrack-update-style.md](references/youtrack-update-style.md) before every draft or polish pass. Output should read like the user's ChatGPT revision thread — **their voice, manager-friendly**, not an agent status report.

**Audience:** @Alejandra.Flores — not a developer. Clarify technical terms in plain language when they appear.

## Step 0 — Toolkit ready

If unsure, call `workflow_toolkit_status`. Stop if `ready: false`.

## Step 1 — Issue (required)

**Always** confirm which YouTrack issue this update is for.

1. If the user did **not** already paste a YouTrack URL or issue id (`NSR-40`) in the message that started this flow, ask:
   > Paste the YouTrack issue URL or id for this update (e.g. `https://…/issue/NSR-40` or `NSR-40`).
2. Wait for their reply. Do **not** guess from spec/plan unless they explicitly say to use the plan's issue.
3. Call `workflow_youtrack_parse_issue` with `issue_ref` = what they pasted.
4. On error, ask again with the parse error. On success, note `issueId`.

## Step 2 — Context (required)

Call `workflow_youtrack_context` with `issue_id` from Step 1 (or `issue_url` / `issue_ref` directly). Stop on error.

Show the resolved issue once in chat: `Updating **{issueId}**` (+ `issueUrl` if returned).

## Step 3 — How to start (required)

Use native `AskQuestion`: title `Draft mode`; prompt `How should we start the YouTrack update?`; options `I have notes` (recommended), `Help me remember`, and `Draft for me`.

### Mode `paste` — I have notes (Recommended)

Ask user to paste rough notes, half-written update, or bullets. Skip to Step 5.

### Mode `remind` — Help me remember

1. Optionally call `workflow_git_context` (and read spec/plan title) **only to remind the user in English chat** — short prose: what repo, branch, themes of commits, not a pasteable comment.
2. Ask conversational follow-ups: *¿Qué te costó más? ¿Qué queda para mañana? ¿Algo bloqueado?*
3. User replies in their words (Spanish messy notes OK).
4. Treat their reply as the draft → Step 5.

**Never** post git context or commit list directly to YouTrack.

### Mode `auto` — Draft for me to edit

1. Use `workflow_git_context` + conversation context to infer what they likely worked on.
2. Write a **first draft in Spanish** per **youtrack-update-style.md** (paragraphs, manager-friendly, no file paths).
3. Show draft in a fenced block. Ask user to correct, add, or replace — user may reply with a full rewrite.
4. Use their corrected version as input → Step 5.

## Step 4 — Duration

Ask time spent on this task issue. User text → `workflow_youtrack_parse_duration`. **Do not compute minutes yourself.**

## Step 5 — Polish (ChatGPT pass)

Polish the approved draft per **youtrack-update-style.md**:

- Paragraphs, not PR bullets
- Technical terms get a short plain-language gloss for the manager
- Keep `# Actualización` + greeting — if user already included them, do not duplicate `@Alejandra.Flores`
- `## Off-topic` only if user's material has a clear tangent section

Call `workflow_youtrack_draft` with:

- `issueId` from Step 1
- `userNotes` = polished **body only** (no `# Actualización`, no greeting line)
- `greeting` from context
- **Do not pass** `projectName`, `facts`, `includeProjectOpener`, or `includeFacts`

## Step 6 — Review

Show returned `markdown` in a fenced block. User may edit in chat (apply edits and re-show if they change wording).

## Step 7 — Post

Use native `AskQuestion`: title `Post to YouTrack`; prompt `Post this reviewed update to YouTrack and log the approved time?`; options `Post and log time` and `Cancel`. On confirm:

`workflow_youtrack_post` with `confirmed: true`, `issueId`, `markdown`, `minutes`. **Do not pass `date`.**

If the result has `partial: true`, the comment already posted. Report the time-log failure and retry only with `workflow_youtrack_log_time` using the same `issueId` and `minutes`; never call `workflow_youtrack_post` again.

## Rules

- Never call YouTrack HTTP directly.
- Never post without `confirmed: true`.
- Never skip Step 1 — each run targets the issue the user names.
- If it sounds robotic, remove structure you added and re-read the style reference.
- End state is always: **user reviewed → post + log time**.
