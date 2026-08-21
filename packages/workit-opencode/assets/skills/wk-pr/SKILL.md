---
name: wk-pr
description: Preview and create a pull or merge request from branch-exclusive facts.
disable-model-invocation: true
---

# Pull request

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workit_pr_context` context tool for branch-exclusive commits and changes; its result is ground truth.
3. Call `workit_verify`, then draft the exact title, body, base, head, and draft state from structured facts.
4. **Show** the exact title and body in chat before any create question.
5. Use native `question` with concise choices and allow a custom answer before creation.
6. Call `workit_pr_create` only after approval with `confirmed: true` and the reviewed fields.
7. Report the structured success, failure stage, or partial result; never infer success.

## GitHub issue linking

When the resolved workspace is github with `link_on_pr` — the `workit_pr_context` tool's `vcs_config` returns `issues_provider: "github"` and `link_on_pr: true` — and no issue is derivable (no `WORKFLOW_GH_ISSUE` env, no numeric branch id like `feature/42-title`, which auto-links without asking), ask with native `question` before creation, exactly three options:

1. **Use an existing issue** — the user provides the number (extract it from a URL if pasted); verify it exists with `gh issue view <n>` before proceeding.
2. **Create a new issue** — via `gh issue create --title "<title>" --body "<body>"`; on success pass the returned number. Reuse the missing-CLI guard: if `gh` is not installed, surface the structured error with the install link and ask the user to confirm once installed.
3. **Skip linking** — no issue line in the PR body.

Pass the chosen issue to pr-create via env: `WORKFLOW_GH_ISSUE=<n>` and, when the PR does NOT resolve the issue, `WORKFLOW_GH_ISSUE_RELATION=related` (default `closes`). The youtrack linking flow (`youtrack.link_issues`) for work workspaces is unchanged.

Only feature or bugfix branches may target the configured base; never create from a protected branch. The body must describe only branch-exclusive changes, follow the repository template when present, and disclose failed or skipped verification. Never expose tokens, edit product files, or fall back to provider CLIs. `todowrite` and `task` are unnecessary here.
