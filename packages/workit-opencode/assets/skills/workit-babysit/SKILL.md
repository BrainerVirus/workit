---
name: workit-babysit
description: Use when a PR needs driving to merge-ready, CI is red, or the user says babysit
---

# Babysit a PR to merge-ready

Babysit starts automatically on PR creation unless declined (`--no-babysit`).
One babysitter per PR; never mutate PR topology (no rebase strategy changes,
no force-push).

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Declare mode: drive (fix + merge), watch (report only), or threads-only.
2. Work the merge frontier in order: conflicts → review threads → CI.
3. Classify CI before retry: flake (rerun once) vs stale base (verify with
   `git merge-base --is-ancestor` before updating) vs real failure (fix).
4. Triage bot findings skeptically: reproduce or quote code before acting;
   invalid bots get a reasoned dismissal, never silent ignore.
5. Batch fixes into one push wave; re-verify green after every push.
6. Merge only when green and approved, honoring `pr` settings (squash +
   delete branch). Stop at the human's line: never merge on explicit hold.

## Completion

PR merged per settings, or a status brief (frontier state, next action) when
blocked on the human. Record evidence for fixes, findings for blockers.
