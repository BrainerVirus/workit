---
name: wf-commit
description: Preview and create a structured local commit without staging.
disable-model-invocation: true
---

# Commit

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_git_context` context tool with any selected paths; its result is ground truth.
3. Draft the exact Conventional Commit message and the already-staged file set.
4. Use native `question` with concise choices and allow a custom answer before committing.
5. Call `workflow_commit` only after approval with `confirmed: true` and the reviewed `message`.
6. Report the structured success, failure stage, or partial result; never infer success.

Never stage files automatically: `workflow_commit` commits the current index only. Stop for an empty index, partial staging ambiguity, unrelated staged files, secrets, protected branches, or failed hooks. Never push, bypass hooks, use `--no-verify`, or claim files were committed unless the result proves it. Keep related code, tests, and docs in one coherent commit; do not invent extra commit groups. `todowrite` and `task` are unnecessary here.
