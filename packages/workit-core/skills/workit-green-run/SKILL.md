---
name: workit-green-run
description: Use to drive a red CI pipeline back to green, usually inside babysit
---

# The CI loop

Watch, classify, fix, push once, re-verify. Host-native (`gh` / GitLab);
never invent CI APIs.


## Method

1. Read the failing checks, not the summary. Quote the failing log lines.
2. Classify each: flake (rerun once, note it) / stale base (update after
   merge-base check) / real failure (reproduce locally, then fix).
3. Fix at root cause with a regression test; push one wave.
4. Re-verify the same checks green on the new head. A fix without a
   green re-run is not a fix.

## Completion

Green pipeline on the merge head, or an escalated finding with the exact
failing logs when the fix needs the human.
