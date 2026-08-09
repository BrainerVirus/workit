---
name: wk-verify
description: Discover and run project validation with workflow_verify.
disable-model-invocation: true
---

# Verify

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_verify` context tool with `dry_run: true`; its result is ground truth.
3. Draft the discovered checks and the proposed selected run from structured facts.
4. When the user must choose checks, use native `question` with concise choices and allow a custom answer.
5. Call `workflow_verify` with `dry_run: false` only for the approved run.
6. Report the structured success, failure stage, or partial result; never infer success.

Do not edit files or fix failures. Report every check exactly as pass, fail, or skipped, including its command, exit code, and skip reason. Success requires every executed check to exit 0. If the user's message says `--dry-run`, stop after discovery.
