---
name: wk-meetings
description: Log meeting time only to the configured YouTrack meeting issue.
disable-model-invocation: true
---

# Meetings

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call read-only `workit_youtrack_context` with `mode: "meetings"`; its sole configured target is ground truth.
3. Ask for duration text, call `workit_youtrack_parse_duration`, and draft the exact IRPT-12 time entry only.
4. Use native `question` with concise choices and allow a custom answer to approve the shown issue, minutes, and work-item text.
5. Call `workit_youtrack_log_time` only after approval with `confirmed: true`, `issueId`, `minutes`, `text`.
6. If `result.data.outcome` is `unknown`, tell the user to reconcile manually and do not retry. Retry `workit_youtrack_log_time` at most once only when `result.data.outcome` is `not_applied` and `result.data.retry` names that tool; follow `result.data.instructions` and correct invalid input before retrying.
7. Report the structured success or failure stage; never infer success.

Use the configured meeting issue even if its default label is IRPT-12. Never compute minutes, pass a date, ask for a meeting type, post a comment, or call `workit_youtrack_post`. `todowrite` and `task` are unnecessary here.
