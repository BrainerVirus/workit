---
name: workit-fanout
description: Run independent slices in parallel - one worker per isolated worktree with a fixed brief and file-scope manifest, a non-author verifier per slice, results in the ledger. Use for fan out, parallelize, parallel agents, split the work, delegate, swarm.
---

# Fan out parallel workers

Fan out only independent slices: disjoint files, no shared mutable state, each
verifiable alone. Code-coupled work stays with one owner, who fans out after
the blocking part lands. A worker whose whole job is re-running one command is
ceremony; do it yourself.

1. **Slice** (workit-shape): each slice gets a branch, a file-scope manifest
   (the globs it may write) and, if it depends on another, its stack parent.
2. **Check disjointness.** No two manifests overlap. Shared files (lockfile,
   registry, barrel exports) belong to one slice, or to you after fan-in.
3. **Brief each worker** with the fixed template and refuse to spawn while a
   field is empty: GOAL, SCOPE (the manifest), CONTEXT (pointers, not pasted
   text), ACCEPTANCE (Given/When/Then), VERIFY (exact commands), TIMEBOX,
   FORBIDDEN, REPORT, STANDING. STANDING is every standing order and user
   directive so far, pasted verbatim into each spawn and respawn, because
   directives decay across resumes. Template: `references/brief.md`.
4. **Spawn all workers in one message**, in the background, each in its own
   worktree (Claude Code: the `implementer` agent; elsewhere
   `git worktree add --detach ../<repo>-wt/<slug> origin/<base>`). The first
   command a worker runs is `workit git branch <branch> --base <base>`.
5. **Judge liveness by side effects only:** new commits and pushes
   (`git log <branch>`), PR and check changes (`workit pr status --branch <b>`).
   No progress past the timebox means stuck. Stop the old worker and observe
   that it exited (a timeout is not proof), then replace it with a fresh one in
   a fresh worktree that continues from the branch head, carrying the
   consolidated brief (original, later directives, its last report). Never two
   live workers on one branch. Replace at most twice, then re-slice or report
   the gap. Never chain resumes.
6. **Verify each slice independently.** A fresh agent that did not write it
   (Claude Code: the `verifier` agent) runs VERIFY and verify-<app>, then
   `workit ledger verdict <result> --branch <b> --how "<evidence>"`. A worker's
   report is a pointer, never evidence.
7. **Fan in.** `workit ledger check --branch <b>` for each slice; restack
   stacked slices with `workit stack sync`. Only you touch topology: workers
   never rebase, retarget or merge. Then workit-ship.

## Example

Bad brief: "Do the API part and add tests." (no scope, no acceptance, no
verify command, so nobody can tell when it is done)

Good brief: `references/brief.md` (GOAL: `GET /v1/usage` returns daily run
counts; SCOPE: `src/routes/usage.ts`, `test/usage.test.ts`; VERIFY:
`workit check test`; ...).

## Check

```sh
workit ledger check --branch <b>   # per slice: accepted (current, passing, independent)
```
