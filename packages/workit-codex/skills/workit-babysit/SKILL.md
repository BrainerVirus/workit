---
name: workit-babysit
description: Use after creating a PR (auto-starts, drive default), when a PR needs driving to merge-ready, CI is red, or the user says babysit
---

# Babysit a PR to merge-ready

Babysit starts automatically on PR creation unless declined (`babysit:false`).
One babysitter per PR; never mutate PR topology (no rebase strategy changes,
no force-push). When a PR URL is observed from a route Workit did not enforce
(for example a raw `gh pr create` the host allowed), load this skill and drive
that PR anyway; do not claim the Workit route was enforced.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Declare mode in the same turn as the PR URL: drive (fix + merge, the
   default), watch (report only), or threads-only.
2. Work the merge frontier in order: conflicts → review threads → CI.
   Record a frontier brief (frontier state, next action) in task progress
   per pass so the steps stay visible.
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

A squash merge creates a new commit on the base branch, so the pre-merge
candidate identity changes: re-record verification and review evidence against
the merged commit before `task.close`, or the close will report unsatisfied
requirements.
