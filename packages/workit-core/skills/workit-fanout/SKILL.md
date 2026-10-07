---
name: workit-fanout
description: Run independent slices in parallel - one worker per isolated worktree with a fixed brief and file-scope manifest, a non-author verifier per slice, results in the ledger. Use for fan out, parallelize, parallel agents, split the work, delegate, swarm.
---

# Fan out parallel workers

Fan out only independent slices: disjoint files, no shared mutable state, each
verifiable alone. Code-coupled work stays with one owner, who fans out after
the blocking part lands. A worker whose whole job is re-running one command is
ceremony; do it yourself.

1. **Plan the slices** (workit-shape) in a plan file (`references/brief.md`):
   per slice an id, branch, TIER, the file-scope manifest (SCOPE globs),
   `owns` for shared files (lockfile, registry, barrels), `dependsOn` only for
   a real dependency (independent PRs off trunk are the default), and the
   brief fields. `workit fanout plan <plan.json>` refuses an empty brief field
   (exit 2) and two slices that may write one file (exit 3) with a fix: an
   owner for a shared file, or a dependency that serializes them. Apply it and
   re-run: refuse to spawn while a field is empty or the plan is refused.
   Its `waves` say which slices may run together; keep 4-6 in flight.
2. **Brief each worker** from its slice with the fixed template: GOAL, SCOPE,
   CONTEXT (pointers, not pasted text), ACCEPTANCE (Given/When/Then), VERIFY
   (exact commands), TIER, TIMEBOX, FORBIDDEN, REPORT, STANDING. STANDING is
   every standing order and user directive so far, pasted verbatim into each
   spawn and respawn, because directives decay across resumes.
3. **Spawn all workers in one message**, in the background, each in its own
   worktree (Claude Code: the `implementer` agent; elsewhere
   `git worktree add --detach ../<repo>-wt/<slug> origin/<base>`). The first
   command a worker runs is `workit git branch <branch> --base <base>`.
4. **Judge liveness by side effects only:** new commits and pushes
   (`git log <branch>`), PR and check changes (`workit pr status --branch <b>`).
   No progress past the timebox means stuck. Stop the old worker and observe
   that it exited (a timeout is not proof). `git worktree remove --force`
   drops its uncommitted changes, so first record `git -C <wt> status --short`
   in the ledger or your report; only then remove the worktree. Respawn with
   the brief in `MODE: resume` (original, later directives, its last report):
   the new worker runs `git switch <branch>` in its fresh worktree instead of
   `workit git branch`. Never two live workers on one branch. Replace at most
   twice, then re-slice or report the gap. Never chain resumes.
5. **Verify each slice independently.** A fresh agent that did not write it
   (Claude Code: the `verifier` agent) runs VERIFY and verify-<app>, then
   `workit ledger verdict <result> --branch <b> --how "<evidence>"` under the
   session you started it with (`WORKIT_SESSION_ID=<lead>-v<n>`, set by you,
   never chosen by the author; Claude Code: the hook names one).
   A worker's report is a pointer, never evidence.
6. **Fan in** with `workit fanout check`: out-of-scope files (any file outside
   it stops the fan-in), and `git merge-tree` conflicts with trunk and between
   siblings, charged to the slice that lands later. Fix what it names (an
   out-of-scope edit becomes a follow-up slice) until it exits 0. A landed
   slice reads as not found: re-plan without it and drop it from dependents'
   `dependsOn`. Then `workit ledger check --branch <b>` per slice; land in its
   order. Stacked slices: `workit stack plan <bottom> … <top>` once, then
   `workit stack sync` and `land`. Only you touch topology: workers never
   rebase, retarget or merge. Then ship (workit-ship).

## Example

Bad brief: "Do the API part and add tests." (no scope, no acceptance, no
verify command, so nobody can tell when it is done)

Good brief: `references/brief.md` (GOAL: `GET /v1/usage` returns daily run
counts; SCOPE: `src/routes/usage.ts`, `test/usage.test.ts`; VERIFY:
`workit check test`; ...).

## Check

```sh
workit fanout check                # exit 0: in scope, no conflicts, landing order printed
workit ledger check --branch <b>   # per slice: accepted (current, passing, independent)
```
