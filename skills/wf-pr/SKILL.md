---
name: wf-pr
description: Preview and create a pull or merge request from branch-exclusive facts.
disable-model-invocation: true
---

# Pull request

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_pr_context` context tool for branch-exclusive commits and changes; its result is ground truth.
3. Call `workflow_verify`, then draft the exact title, body, base, head, and draft state from structured facts.
4. **Show** the exact title and body in chat before any create question.
5. Use native `question` with concise choices and allow a custom answer before creation.
6. Call `workflow_pr_create` only after approval with `confirmed: true` and the reviewed fields.
7. Report the structured success, failure stage, or partial result; never infer success.

Only feature or bugfix branches may target the configured base; never create from a protected branch. The body must describe only branch-exclusive changes, follow the repository template when present, and disclose failed or skipped verification. Never expose tokens, edit product files, or fall back to provider CLIs. `todowrite` and `task` are unnecessary here.
