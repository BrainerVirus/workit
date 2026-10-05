---
name: workit-continue
description: Keep work on track across interruptions and sessions - sort new input, checkpoint, hand off with a resume brief, and pick up by verifying inherited claims. Use for resume, pick up, handoff, new session, interruption, change of direction.
---

# Continue without losing the thread

## New input mid-task

- **Quick question:** answer it; change nothing else.
- **Same-task adjustment:** update the affected constraint and next step, then
  keep going.
- **Separate request:** do not silently resume an old objective, and do not
  drop the current one. Checkpoint it (below) if it must continue later, then
  start the new work. Held items stay parked with their resume condition until
  the user resumes them.

## Checkpoint and hand off

```sh
workit git commit -m "wip: <state>" --all   # nothing lives only in your context
workit handoff --note "<state in one line>" --next "<next command>" --record
```

The brief carries the branch, HEAD, dirty state, check freshness, verdict,
rulings and the next command. Add only what it cannot know: choices still
open, approaches that failed and why. Work spanning repos gets one brief per
checkout, each with its branch and delivery endpoint.

## Pick up

1. In the checkout: `workit handoff`, then `workit ledger list` and
   `git log --oneline -10`.
2. Trust the trail, verify the claims: re-run the checks the brief calls
   stale, and confirm each "done" item against the goal on the real artifact
   (a pushed SHA, a PR state, a running feature). Do not re-derive settled
   decisions.
3. Continue to the recorded endpoint with the brief's next command.

## Example

Bad: a new session re-reads the whole codebase, re-asks the user which
approach to take, and redoes a finished slice.

Good: "`workit handoff`: feature/usage at 4be1, `test` stale, verdict none,
next `workit check test`. Re-ran it: exit 0. The brief says PR #42 is open:
`workit pr status` confirms, CI pending. Continuing with workit-ship."

## Check

```sh
workit handoff   # read: "next command" is set and no check is listed as stale
```
