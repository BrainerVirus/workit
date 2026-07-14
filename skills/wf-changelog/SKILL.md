---
name: wf-changelog
description: Update CHANGELOG.md via workflow_changelog_context + workflow_changelog_apply. Use for /wf-changelog or "update the changelog".
---

# Changelog — Keep a Changelog Update

Update `CHANGELOG.md` for the current repository.

## Step 1 — Gather facts (required)

Call MCP tool `workflow_changelog_context` with arguments from the user's message (range, version, paths, etc.).

**Workspace root:** defaults to the Cursor workspace. Pass `workspace_root` when the user names a different repository path.

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

If `unreleased.needs_normalize` is true, call `workflow_changelog_apply` with `normalize_only: true` before merging new bullets.

## Step 2 — Decide entries (do not edit the file yet)

Follow Keep a Changelog 1.1.0:

- Target `## [Unreleased]` only (unless the user asks to cut a version).
- Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Human-readable bullets, not raw commit messages.
- Group by user-visible behavior, not by file.
- Skip internal refactors / CI / tests / formatting unless they affect users.
- If there are no meaningful user-visible changes, stop — do not invent entries.

## Step 3 — Apply via tool (required)

Call MCP `workflow_changelog_apply` with the new bullets. Examples:

```json
{
  "entries": {
    "Added": ["**Foo API** — public endpoint for bar"],
    "Fixed": ["**Login redirect** — stop loop on expired session"]
  }
}
```

or

```json
{
  "entries": [
    { "category": "Added", "text": "**Foo API** — public endpoint for bar" }
  ]
}
```

### HARD-GATE

- **NEVER** hand-edit `CHANGELOG.md` to append a new `### Added` / `### Changed` / … block under `[Unreleased]`.
- The apply tool **merges** into the existing category heading (or creates one category once).
- Duplicate identical bullets are skipped.
- Do not update package versions or tags.
- Do not commit.

## Output

After the tool returns ok, summarize:

```md
Changelog update:

- <entry or reason no update was needed>

Files changed:

- CHANGELOG.md
```
