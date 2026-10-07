---
name: workit-fanout
description: Run independent slices in parallel - one worker per isolated worktree with a fixed brief and file-scope manifest, a non-author verifier per slice, results in the ledger. Use for fan out, parallelize, parallel agents, split the work, delegate, swarm.
---

# Fan out parallel workers

Fan out only independent slices: disjoint files, no shared mutable state, each
verifiable alone. Code-coupled work stays with one owner, who fans out after
the blocking part lands. A worker whose whole job is re-running one command is
ceremony; do it yourself. Workit never spawns agents; you do.

1. **Plan the slices** (workit-shape) in a plan file (`references/brief.md`):
   per slice an id, branch, TIER, SCOPE globs, `owns` for shared files,
   `dependsOn` only for a real dependency, and the brief fields. `workit fanout
   plan <plan.json>` refuses an empty or placeholder brief field (exit 2) and
   two slices that may write one file (exit 3) with a fix; apply it and re-run:
   refuse to spawn while a field is empty or the plan is refused. One PR per
   slice is the default; `"fanIn": "integration"` only when the user wants one
   PR (`references/orchestration.md`).
2. **Record standing orders** (`workit ledger standing add "<order>"`): every
   user directive all workers share. Directives decay across resumes.
3. **Brief each worker verbatim** with `workit fanout brief <slice>`: plan
   fields, standing orders, SCRATCH, session id, fan-in rule. Never hand-edit
   it; change the plan or the standing orders and render again.
4. **Spawn in a rolling window**, in the background, each in its own worktree:
   keep 4-6 in flight and refill from `spawnable` in `workit fanout status` as
   each one finishes. Pick the model from TIER (`references/orchestration.md`).
   Claude Code: the `implementer` agent; elsewhere first `workit fanout
   worktree create <slice>`.
5. **Judge liveness by side effects only:** `workit fanout status` (head age,
   PR, CI, verdict, landed; STUCK past the TIMEBOX). Stop a stuck worker and
   observe that it exited (a timeout is not proof). Removing a worktree drops
   its uncommitted changes: `workit fanout worktree release <slice>` records
   `git status` in the ledger first and refuses them without `--force`. Never
   two live workers on one branch.
6. **Retry once, then escalate.** A stuck or failed slice gets one retry with
   a fresh brief (`workit fanout brief <slice> --mode resume`, same branch);
   if that fails too, re-slice it, take it over, or report the gap. Never
   chain resumes. A hard slice may race instead: N attempts, keep the best
   verdict (`references/orchestration.md`).
7. **Verify by the workspace `verification` setting** (`workit grant show`).
   A report is a pointer, never evidence. `self`: a verifier that wrote none
   of the slices, or you if you wrote none. `independent` or high risk: a
   separate verifier session, never yours (doctrine: the ledger only refuses
   authors). One verifier may take a batch of slices, one verdict per branch
   (`workit ledger verdict <result> --branch <b> --how "<evidence>"`), in a
   session never chosen by the author. A review panel on separate models only at high risk.
8. **Fan in** with `workit fanout check`: out-of-scope files (any file outside
   it stops the fan-in) and `git merge-tree` conflicts with trunk and between
   siblings. Fix what it names until it exits 0; a merged slice reads as
   landed. Then `workit ledger check --branch <b>` per slice, land in `fanout
   status` order, release the worktrees you made, and `workit ledger standing
   clear`. Only you touch topology: workers never rebase, retarget or merge,
   except the integration-tip merge in integration mode. Then ship
   (workit-ship).

## Example

Bad brief: "Do the API part and add tests." (no scope, no acceptance, no
verify command, so nobody can tell when it is done)

Good brief: the output of `workit fanout brief usage-endpoint`
(`references/brief.md` shows one).

## Check

```sh
workit fanout check                # exit 0: in scope, no conflicts, landing order printed
workit ledger check --branch <b>   # per slice: accepted (current, passing, independent)
```
