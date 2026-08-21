---
name: wk-docs-refresh
description: Refresh stale README and docs via workit_docs_context. Use for /wk-docs-refresh or "refresh readme/docs".
---

# Docs Refresh — Documentation Refresh

Inspect current changes and refresh stale documentation.

## Step 1 — Gather facts (required)

Call MCP tool `workit_docs_context` with arguments from the user's message (range, version, paths, etc.).

**Repository calls:** For every repository-scoped `workflow_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

## Rules

- Prefer updating `README.md` first when it is stale.
- Also update docs that are directly referenced by changed files or listed in the context.
- Do not rewrite docs stylistically when facts are already correct.
- Do not invent features, commands, env vars, screenshots, release notes, or install steps.
- Preserve existing tone and structure.
- If a needed fact cannot be verified from the repository, leave a concise note in the response instead of guessing.
- Do not commit.

## Output

After any edits, summarize:

```md
Docs refreshed:

- <file>: <what changed>

Skipped:

- <file or topic>: <why>
```
