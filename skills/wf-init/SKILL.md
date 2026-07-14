---
name: wf-init
description: Preview and apply one-time workflow-toolkit configuration.
disable-model-invocation: true
---

# Init

1. Load this skill explicitly through OpenCode's `skill` tool.
2. Call the read-only `workflow_toolkit_init_status` context tool; its result is ground truth.
3. Draft an exact preview of each missing scaffold and the active VCS provider.
4. For each guarded mutation, use native `question` with concise choices and allow a custom answer.
5. Call `workflow_toolkit_init_apply` only after approval with `confirmed: true` and the chosen action.
6. Report the structured success, failure stage, or partial result; never infer success.

Never ask for or accept tokens in chat. For missing YouTrack configuration, preview `youtrack_scaffold`; for missing VCS configuration, ask GitLab or GitHub, preview `vcs_scaffold`, and pass `vcs_provider`. Both provider token placeholders may be created, but identify which one is active. Show the returned token-create URL and local edit path after apply. Verification remains a separate `wf-status` run. `todowrite` and `task` are unnecessary here.
