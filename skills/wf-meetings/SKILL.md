---
name: wf-meetings
description: Log meeting time only to the configured YouTrack meeting issue (default IRPT-12). No comments. Use /wf-meetings.
disable-model-invocation: true
---

# Meetings — time only

Log meeting time to a **meeting issue** from config. **Never post a comment.**

**Agent language:** English unless the user writes in another language.

## Step 0 — Toolkit ready

If unsure, call `workflow_toolkit_status`. Stop if `ready: false`.

## Step 1 — Context (required)

Call MCP `workflow_youtrack_context` with `mode: "meetings"` (no `issue_id` yet). Stop on error.

## Step 2 — Use the configured target

Use the sole entry in `meetingOptions` returned by context. Do not ask the user to pick a meeting type; the configured `meetingIssue` is authoritative.

## Step 3 — Duration

Ask how much meeting time today (English UI). User text → `workflow_youtrack_parse_duration`. **Do not compute minutes yourself.**

## Step 4 — Preview + confirm

Show preview: chosen issue, label, minutes, work-item text.

Use native **AskQuestion** to confirm logging the shown meeting time; on yes:

## Step 5 — Log time only

Call `workflow_youtrack_log_time` with `confirmed: true`, `issueId`, `minutes`, `text` (from `workItemText`). **Do not pass `date`** — tool uses epoch ms automatically.

**Never** call `workflow_youtrack_post` from this skill.

## Rules

- Tools only — no direct YouTrack HTTP.
- No comment on meeting issues.
