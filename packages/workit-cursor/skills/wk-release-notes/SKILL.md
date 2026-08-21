---
name: wk-release-notes
description: Draft release notes via workit_release_notes_context. Use for /wk-release-notes or "draft release notes".
---

# Release Notes — User-Facing Release Notes

Draft release notes for a given release, version, tag, or commit range.

## Step 1 — Gather facts (required)

If the user did not provide an exact tag, version, or commit range, ask for it before calling the tool.

Call MCP tool `workit_release_notes_context` with arguments from the user's message (range, version, paths, etc.).

**Repository calls:** For every repository-scoped `workit_*` call, pass the active Cursor workspace as `workspace_root`; never rely on the MCP process default.

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

Pass tag or range strings as `range_or_tag`.

## Rules

- Do not edit files unless the user explicitly asks for an edit target.
- Do not create or publish a release.
- Write for users, not maintainers.
- Mention features, behavior changes, fixes, migration notes, installation/update notes, and known issues when supported by context.
- Do not mention CI, tests, refactors, formatting, dependency bumps, or internal tooling unless they directly affect users.
- If the requested release/range is missing or ambiguous, ask for the exact tag, version, or commit range.
- If there are no user-facing changes, say that directly.

## Output

Return only:

```md
# <Release title>

## Highlights

- ...

## Fixes

- ...

## Upgrade Notes

- ...

## Known Issues

- ...
```

Omit empty sections except `Highlights`. If `Highlights` would be empty, output a short note explaining why.
