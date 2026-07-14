---
name: wf-changelog
description: Preview and apply a Keep a Changelog update.
---

# Changelog

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_changelog_context` context tool; its result is ground truth.
3. Draft the exact insertion preview, including target heading, categories, and bullets.
4. Use native `question` with concise choices and allow a custom answer before changing the file.
5. Call `workflow_changelog_apply` only after approval with `confirmed: true`.
6. Report the structured success, failure stage, or partial result; never infer success.

Target `## [Unreleased]` unless the user requests a release. Use only Added, Changed, Deprecated, Removed, Fixed, or Security; group user-visible behavior and skip internal-only work. The apply tool must merge into existing category headings, preserve all unrelated lines, and skip duplicate bullets. If normalization is needed, include it in the same preview and approval. Do not hand-edit the changelog, version packages, tag, or commit. `todowrite` and `task` are unnecessary here.
