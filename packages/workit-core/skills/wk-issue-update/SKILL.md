---
name: wk-issue-update
description: Draft and post a reviewed es-CL YouTrack task update with time.
disable-model-invocation: true
---

# Issue update

Read [references/youtrack-update-style.md](references/youtrack-update-style.md) before drafting. Chat follows the user's language; the comment body is manager-friendly Spanish (`es-CL`).

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Ask in plain prose for the user-provided issue URL or ID, call `workit_youtrack_parse_issue`, then read-only `workit_youtrack_context`; structured results are ground truth.
3. Gather the user's notes, call `workit_youtrack_parse_duration`, polish only supported facts, and call `workit_youtrack_draft` for the exact comment preview.
4. Use native `question` with concise choices and allow a custom answer to approve the reviewed comment and time entry.
5. Call `workit_youtrack_post` only after approval with `confirmed: true`, `issueId`, `markdown`, and `minutes`.
6. Report the structured success, failure stage, or partial result; never infer success.

Never guess the issue, compute minutes, pass a date, expose tokens, or post Git/file details as the update. Never present a clickable `question` option whose label is an instruction to type free text (e.g. "Type the issue URL/ID"): clicking an option returns the label literal, not the typed value, so ask for free text in prose instead, with the custom answer field enabled. Preserve the user's paragraph voice, explain technical terms plainly, and avoid robotic status bullets. `todowrite` and `task` are unnecessary here.

Consume the standard Result envelope:

- If `result.ok` is true, report only effects proven by `result.data`.
- If false, use `result.data.postedComment` and `result.data.loggedMinutes` to distinguish completed effects.
- If `result.data.retry === "workit_youtrack_post"`, use native `question` to ask whether to retry the unchanged reviewed `issueId`, `markdown`, and `minutes`. On approval, call `workit_youtrack_post` with `confirmed: true` at most once; never loop.
- If `result.data.retry === "workit_youtrack_log_time"`, use native `question` to ask whether to retry the same `issueId` and `minutes`. On approval, call `workit_youtrack_log_time` with `confirmed: true`, `issueId`, `minutes` at most once; never repost a known posted comment.
- If the second attempt fails, stop and report its structured result. Never switch retry tools or infer that either effect succeeded.
- If outcome is `unknown` or `result.data.retry` is absent, show `result.data.instructions` when present, reconcile manually, and do not retry either mutation.
