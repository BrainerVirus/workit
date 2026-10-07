# Running a fanout

How the lead picks models, keeps workers flowing, retries, races, verifies
and fans in. Workit records and checks; the host's own subagents run the work.

## TIER to model

TIER is a field of each slice and of its brief. Map it where the host lets you
pick a model per spawn; nothing in the workspace config routes it.

| TIER | Claude Code (`model` on the Agent call) | Hosts without a per-spawn model |
| --- | --- | --- |
| scouting (read-only search, not a slice) | `haiku` | host default |
| mundane | `sonnet` | host default |
| standard | omit it (inherits yours) | host default |
| hard | omit it (inherits yours); consider a race | host default |

OpenCode takes a subagent's model from its agent config: pick a configured
agent whose model fits the TIER, else the default. Codex, Cursor and Pi run
every worker on the host's model, so TIER only sizes the timebox and decides
whether to race.

## Rolling window

Keep 4-6 workers in flight on Claude Code; elsewhere as many as the host runs
in the background, never more than 6. Do not wait for a whole wave: when one
worker finishes (its notification, or a new head or PR in `workit fanout
status`), verify it, then spawn the next slice from `spawnable` in the same
status output. A slice whose dependencies landed, or a stacked child whose
parent is verified, appears there by itself.

## Retry, then escalate

A slice is retried when it is STUCK, its worker exits without meeting
ACCEPTANCE, or its verdict fails. Stop the worker and observe that it exited.
Release its worktree: `workit fanout worktree release <slice>` (native
worktrees: record `git -C <wt> status --short` first). Then spawn one fresh
worker with `workit fanout brief <slice> --mode resume`: same branch, and the
brief points at its head and its ledger rows (last report, verdicts,
rulings). If the retry fails too, escalate instead of a third worker:
re-slice it smaller (`workit fanout plan` again), take it over yourself, or
report the gap to the user.

## Race a hard slice

When a hard slice has an uncertain approach and a cheap VERIFY, run 2-3
attempts at once instead of retrying in series. `workit fanout brief <slice>
--attempt <n>` gives each attempt its own branch (`<branch>-try<n>`), session
and scratch dir. Each attempt needs its own worktree: Claude Code's
`implementer` isolates natively; on other hosts `fanout worktree create` makes
only the slice's own worktree, so run the attempts one after another there.
Verify every attempt, keep the one with the best verdict (accepted first,
then the fewest changed files, then the earliest), point the slice branch at
it (`git branch <branch> <winner>`), have the verifier record the verdict on
`<branch>` (same head), and delete the losing attempt branches.

## Verification

Follow the workspace `verification` setting (`workit grant show`); the
worker never records a verdict on its own work.

- Normal: a verifier that wrote none of the slices records the verdicts. A
  lead that authored none of the slices may record them in its own session.
- `verification: independent` and high risk: never the lead's own session.
  A separate verifier session records them (`WORKIT_SESSION_ID=<lead>-v<n>`,
  or `--as verifier`); at high risk one verifier per slice, plus a review
  panel (below).

A batch verifier takes several slices on one surface in one session: for
each branch it checks out the head, runs that slice's VERIFY, and records its
own `workit ledger verdict <result> --branch <b> --how "<evidence>"`. Every
verdict is keyed to that branch's head SHA; a slice whose head moves after
it needs a new one. Batch at most what fits one context, about 4 slices.

## Review panel (high risk only)

At risk=high only, 2-3 fresh reviewers (read the `workit-review` skill's SKILL.md and follow it), each on a model
other than the author's (Claude Code: a different `model`), each records
`workit ledger verdict <result> --kind review --branch <b> --how "<findings>"`.
Land only when every panel verdict passes. Below high risk a panel costs
more than it finds.

## Integration-branch fan-in (one PR)

Only when the user wants one PR for the whole fanout:

1. Cut the integration branch (`workit git branch <integration> --base
   <trunk>`) and plan with `"fanIn": "integration"` and `--trunk
   <integration>`. Planning refuses integration mode on origin's default
   branch.
2. Every brief then tells the worker to merge the integration tip into its
   branch before reporting (the fast-forward rule). That merge is the only
   one a worker makes, and only in this mode.
3. Land each verified slice with `git merge --ff-only <slice-branch>` in the
   integration checkout. Not a fast-forward (the tip moved since the worker
   merged)? Resume the worker to merge again; never a merge commit of your own.
4. `workit fanout check` gates against the integration branch; a slice whose
   tip is on it reads as landed. When all have landed, ship the integration
   branch as one PR (read the `workit-ship` skill's SKILL.md and follow it).

## Stacks

For stacked slices (`dependsOn` one parent): `workit stack plan <bottom> …
<top>` once, then `workit stack sync` and `workit stack land`.
