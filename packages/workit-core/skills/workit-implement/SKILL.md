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
   Tracking it? Judge once: `workit policy assess --judge risk=normal
   behavior=yes product-choice=no plan=no` (trivial and no for a mechanical
   fix); Workit derives what close needs.
3. Small steps that each leave the tree green. Behavior change: write the
   acceptance as Given/When/Then and see a test fail first (workit-bdd).
   Mechanical change: the existing checks are enough. No tautological tests:
   a test must fail if the behavior breaks, never restate the implementation.
4. Run the real checks: `workit check test` (and `lint`, `typecheck` when the
   repo has them).
5. Prove the feature on its real surface with the project's `verify-<app>`
   skill; none yet? Write one (workit-verify-app). Tests show branch behavior,
   not that the feature works.
6. Commit: `workit git commit -m "<type>: <what>" -- <paths>` (or `--all`).
   No endpoint named? Stop here and state the next command. Hand delivery to
   ship, which pushes and opens the PR with its body shape (workit-ship), only
   when that was requested, or the request implies delivery and the effective
   endpoint in `workit grant show` is `pr`, `green` or `merged`; `green` and
   `merged` keep babysitting. Otherwise it is `commit`.
7. Verify. Normal risk: after `workit check test` passes, record your own
   `workit ledger verdict tests-verified --self --how "<what you ran>"`; it
   reads self-reviewed, never verified. High risk, a workspace with
   `verification: independent` (`workit grant show`) or a verified merge needs
   a fresh verifier with its own session (`WORKIT_SESSION_ID=<yours>-v1`;
   Claude Code: the `verifier` agent). Before saying done, reconcile
   every named deliverable against the target checkout and observe it (for a push:
   `workit verify-delivery push`).

Independent slices that could run in parallel: fan them out (workit-fanout).

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
