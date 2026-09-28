---
name: workit-babysit
description: Use when the user asks to babysit a PR or explicitly opts in to PR follow-up
---

# Babysit a PR to PR-ready

PR creation does not start babysitting. `babysit:true` opts into this skill;
omission means no follow-up. A PR URL by itself is not an instruction to drive
it. When the user asks to babysit a URL from a route Workit did not enforce,
help without claiming the Workit route was enforced. Never mutate PR topology
(no rebase strategy changes, no force-push).


## Method

1. Default to drive mode for an explicit babysit request: resolve conflicts,
   address review threads, and get checks green. Watch reports status only;
   threads-only addresses review threads. Ask about mode only when the choice
   materially changes the work.
2. Work toward PR-ready in order: conflicts → review threads → CI. Keep a brief
   checkpoint when continuity needs it; task progress is optional.
3. Classify CI before retry: flake (rerun once) vs stale base (verify with
   `git merge-base --is-ancestor` before updating) vs real failure (fix).
4. Triage bot findings skeptically: reproduce or quote code before acting;
   invalid bots get a reasoned dismissal, never silent ignore.
5. Batch fixes into one push wave; re-verify green after every push.
6. Stop at PR-ready. A PR creation or babysit request does not authorize merge
   or release. Continue to merge or release only when the user explicitly sets
   that delivery endpoint and host authority allows the action.

## Completion

Report PR-ready status with evidence for fixes, or a brief blocker report. If
the user explicitly authorized merge, honor the configured strategy only after
checks and required approval. After a squash merge, re-record evidence against
the new base commit before closing tracked work.
