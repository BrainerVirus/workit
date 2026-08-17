---
name: wk-status
description: Report workit, YouTrack, and VCS health.
disable-model-invocation: true
---

# Status

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workit_status` context tool once; its result is ground truth.
3. Draft the health report from structured facts.
4. This workflow has no guarded mutation and does not need `question`.
5. Do not call any mutation tool.
6. Report the structured success, failure stage, or partial result; never infer success.

Show every `items[]` result, the resolved YouTrack settings and verification, the VCS provider and verification, and the exact `ready` verdict. For placeholders, point to the returned token creation and edit paths; never request tokens in chat. Use only `workit_status` and report its structured state. Do not run shell, Git, direct HTTP, isolated token verification, or any mutation. `todowrite` and `task` are unnecessary for this read-only workflow.
