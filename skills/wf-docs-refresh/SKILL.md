---
name: wf-docs-refresh
description: Refresh stale repository documentation from structured change context.
---

# Docs refresh

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_docs_context` context tool; its result is ground truth.
3. Draft the smallest factual documentation edit from structured facts.
4. Use native `question` with concise choices and allow a custom answer only if the requested edit scope is ambiguous.
5. Apply approved edits with normal OpenCode file tools, then call `workflow_verify`.
6. Report the structured success, failure stage, or partial result; never infer success.

Prefer README changes when stale, then directly related tracked documentation. Preserve tone and structure; do not invent features, commands, environment variables, screenshots, or install steps. Do not make stylistic rewrites, commit, or modify product code. Report verification exactly. Use `todowrite` only when multiple requested documents need tracking; `task` is unnecessary.
