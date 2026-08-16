---
name: wk-handoff
description: Create and optionally select a seeded OpenCode continuation session.
disable-model-invocation: true
---

# Handoff

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the automatic `workflow_handoff_session` tool with the full user message as `message`; its result is ground truth.
3. The tool resolves the tracked spec, plan, and SDD context and seeds the continuation session.
4. This workflow needs no `question`: the explicit invocation is approval.
5. Pass only `message`; the tool itself recognizes an exact `--stay` flag and otherwise selects the new session.
6. Report the structured success, failure stage, or partial result; never infer success.
7. After any `workflow_handoff_session` result—success, partial, or failure—end the originating turn immediately after one status message. Never create todos, execute the plan inline, modify files, retry handoff, or call another tool.

Never emit a continuation prompt, use the clipboard, or ask the user to copy text. If selected, report the session ID only if the current session remains visible. If staying, report the seeded session ID. On failure, report `stage` and `error`; preserve any returned session for the session picker and never recreate it automatically. `todowrite` and `task` are unnecessary here.

A destination run that executes the plan must still end with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes.
