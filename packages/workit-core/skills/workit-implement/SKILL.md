---
name: workit-implement
description: Build a requested change in small verified steps - follow local patterns, run real checks with workit check, prove it on the running app, hand verification to a non-author. Use for implement, build, add a feature, make the change, code it.
---

# Implement and prove it works

## Steps

1. Read before writing: the files you will touch, their callers, and one
   neighbour that already does something similar. Copy its patterns, names and
   error handling. Repo rules (AGENTS.md, CLAUDE.md, lint config) win.
2. On the default branch? Branch first: `workit git branch --kind feature --slug <s>`.
3. Small steps that each leave the tree green. Behavior change: write the
   acceptance as Given/When/Then and see a test fail first (workit-bdd).
   Mechanical change: the existing checks are enough.
4. Run the real checks: `workit check test` (and `lint`, `typecheck` when the
   repo has them). A recorded "tests pass" is a note; an observed run counts.
5. Prove the feature on its real surface with the project's `verify-<app>`
   skill (none yet? workit-verify-app writes one). Tests show branch behavior,
   not that the feature works.
6. Deliver to the endpoint you were given (none named: the default ceiling, a
   pushed PR): `workit git commit -m "<type>: <what>" -- <paths>` (or `--all`),
   then `workit git push` and `workit pr create --fill`; then workit-ship.
7. Hand off verification. Never record a passing verdict on your own work: a
   fresh agent (Claude Code: the `verifier` agent) runs verify-<app> and
   `workit ledger verdict`. Before saying done, reconcile every named
   deliverable against the target checkout and observe it (for a push:
   `workit verify-delivery push`).

Independent slices that could run in parallel go to workit-fanout. When a step
stalls on a fact, find it (read, run, prototype); ask only for a product or
preference choice, with your recommended answer.

## Example

Bad: "Done - added the --since flag, tests pass." (no check ran this turn; the
flag was never invoked)

Good: "Added `--since`. measured: `workit check test` exit 0;
`mytool log --since 2d` printed 3 entries against the fixture repo. inferred:
the GitLab path behaves the same (shared parser, not run). Verification handed
to the verifier agent."

## Check

```sh
workit check test   # then, when the endpoint was a push or beyond: workit verify-delivery push
```
