---
name: wf-handoff
description: Create and optionally select a seeded OpenCode continuation session.
disable-model-invocation: true
---

# Handoff

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the automatic `workflow_handoff_session` tool with the full user message as `message`; its result is ground truth.
3. The tool resolves the tracked spec, plan, and SDD context and seeds the continuation session.
4. This workflow needs no `question`: the explicit invocation is approval.
5. Forward `--stay` as `stay: true`; otherwise let the tool select the new session.
6. Report the structured success, failure stage, or partial result; never infer success.

Never emit a continuation prompt, use the clipboard, or ask the user to copy text. If selected, report the session ID only if the current session remains visible. If staying, report the seeded session ID. On failure, report `stage` and `error`; preserve any returned session for the session picker and never recreate it automatically. `todowrite` and `task` are unnecessary here.
