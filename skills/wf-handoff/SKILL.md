---
name: wf-handoff
description: Create, seed, and optionally open a clean OpenCode continuation session. Explicit /wf-handoff only.
disable-model-invocation: true
---

# Handoff

Call `workflow_handoff_session` with the full user message as `message`. Set `stay: true` only when the command arguments include `--stay`.

The tool resolves the active spec, plan, and SDD paths, creates a child of the current session, seeds its continuation prompt, and selects it unless `--stay` was requested. Use its result as ground truth. Do not emit or ask the user to copy a prompt.

## Success

- When `selected` is `true`, the TUI normally switches immediately. Only if this session remains visible, report `Opened session <sessionID>`.
- When `selected` is `false`, report `Seeded session <sessionID>; staying in the current session.`

## Failure

Report the returned `stage` and `error`. If `sessionID` is present, state that the session was preserved and can be opened from the OpenCode session picker (`/sessions`) using that ID. Never delete or recreate it automatically.
