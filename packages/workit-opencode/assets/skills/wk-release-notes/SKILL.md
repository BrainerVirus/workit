---
name: wk-release-notes
description: Draft user-facing release notes for an explicit range.
---

# Release notes

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Require an exact version, tag, or commit range, then call the read-only `workit_release_notes_context`; its result is ground truth.
3. Draft notes from structured facts and include both requested and resolved range metadata.
4. Use native `question` only when the exact range must be supplied or corrected; allow a custom answer.
5. This workflow has no mutation tool.
6. Report the structured success, failure stage, or partial result; never infer success.

Write for users: supported highlights, fixes, upgrade notes, and known issues only. Omit empty sections except Highlights, and say directly when the resolved range contains no user-facing changes. Do not edit files, publish a release, or infer a range. `todowrite` and `task` are unnecessary here.
