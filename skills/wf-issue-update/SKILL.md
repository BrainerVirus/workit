---
name: wf-issue-update
description: Draft and post a reviewed es-CL YouTrack task update with time.
disable-model-invocation: true
---

# Issue update

Read [references/youtrack-update-style.md](references/youtrack-update-style.md) before drafting. Chat follows the user's language; the comment body is manager-friendly Spanish (`es-CL`).

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Require the user-provided issue URL or ID, call `workflow_youtrack_parse_issue`, then read-only `workflow_youtrack_context`; structured results are ground truth.
3. Gather the user's notes, call `workflow_youtrack_parse_duration`, polish only supported facts, and call `workflow_youtrack_draft` for the exact comment preview.
4. Use native `question` with concise choices and allow a custom answer to approve the reviewed comment and time entry.
5. Call `workflow_youtrack_post` only after approval with `confirmed: true`, `issueId`, `markdown`, and `minutes`.
6. Report the structured success, failure stage, or partial result; never infer success.

Never guess the issue, compute minutes, pass a date, expose tokens, or post Git/file details as the update. Preserve the user's paragraph voice, explain technical terms plainly, and avoid robotic status bullets. `todowrite` and `task` are unnecessary here.

Consume the standard Result envelope:

- If `result.ok` is true, report only effects proven by `result.data`.
- If false, use `result.data.postedComment` and `result.data.loggedMinutes` to distinguish completed effects.
- Retry only the missing effect named by `result.data.retry`. If it is `workflow_youtrack_log_time`, call that tool once with `confirmed: true`, `issueId`, `minutes`; never repost a known posted comment.
- When outcome is `unknown`, show `result.data.instructions`, reconcile manually, and do not retry either mutation.
