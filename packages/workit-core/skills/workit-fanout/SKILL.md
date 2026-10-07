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
   brief fields. `workit fanout plan <plan.json>` refuses an empty or
   placeholder (`<goal>`, `TBD`) brief field (exit 2) and two slices that may
   write one file (exit 3) with a fix: an owner for a shared file, or a
   dependency that serializes them. Apply it and re-run: refuse to spawn while
   a field is empty or the plan is refused. Its `waves` say which slices may
   run together; keep 4-6 in flight.
2. **Brief each worker** from its slice with the fixed template: GOAL, SCOPE,
   CONTEXT (pointers, not pasted text), ACCEPTANCE (Given/When/Then), VERIFY
   (exact commands), TIER, TIMEBOX, SCRATCH, FORBIDDEN, REPORT, STANDING.
   STANDING is every standing order and user directive so far, pasted
   verbatim into each spawn and respawn: directives decay across resumes.
3. **Spawn all workers in one message**, in the background, each in its own
   worktree: Claude Code's `implementer` agent (first command `workit git
   branch <branch> --base <base>`); elsewhere `workit fanout worktree create
   <slice>`, which prints the SCRATCH dir. Refill from `fanout status`.
4. **Judge liveness by side effects only:** `workit fanout status` (head age,
   PR, CI, verdict, landed; STUCK past the TIMEBOX, default 30 min). Stop a
   stuck worker and observe that it exited (a timeout is not proof). Removing
   a worktree drops its uncommitted changes: `workit fanout worktree release
   <slice>` records `git status` in the ledger first and refuses them without
   `--force` (native worktrees: record `git -C <wt> status --short` first).
   Respawn in `MODE: resume` (brief, directives, last report), same branch.
   Never two live workers on one branch. Replace at most twice, then re-slice
   or report the gap. Never chain resumes.
5. **Verify each slice independently.** A fresh agent that did not write it
   (Claude Code: the `verifier` agent) runs VERIFY and verify-<app>, then
   `workit ledger verdict <result> --branch <b> --how "<evidence>"` under the
   session you started it with (`WORKIT_SESSION_ID=<lead>-v<n>`, set by you,
   never chosen by the author; Claude Code: the hook names one).
   A worker's report is a pointer, never evidence.
6. **Fan in** with `workit fanout check`: out-of-scope files (any file outside
   it stops the fan-in), and `git merge-tree` conflicts with trunk and between
   siblings, charged to the slice that lands later. Fix what it names (an
   out-of-scope edit becomes a follow-up slice) until it exits 0. A slice
   whose PR merged reads as landed; its dependents stop waiting. Then
   `workit ledger check --branch <b>` per slice, land in `fanout status` order
   and release the worktrees you made. Stacks: `workit stack plan <bottom> …
   <top>` once, then `stack sync` and `land`. Only you touch topology: workers
   never rebase, retarget or merge. Then ship (workit-ship).

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
