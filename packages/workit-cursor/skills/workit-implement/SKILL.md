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
   Tracking it? Judge once: `workit policy assess --judge risk=normal behavior=yes
   product-choice=no plan=no` (trivial and no for a mechanical fix). Already
   judged? Cite the plan with `--ref <path>` or record the decision; don't re-judge.
3. Small steps, each leaving the tree green. Behavior change: write the
   acceptance as Given/When/Then and see a test fail first (read the `workit-bdd` skill's SKILL.md and follow it).
   Mechanical change: existing checks are enough. No tautological tests:
   a test must fail if the behavior breaks, never restate the implementation.
4. Run the real checks, local-first: the targeted test or check for the file
   you touched while you work, then the full set once at the end
   (`workit check test`, plus `lint` and `typecheck` when the repo has them),
   not after every edit. Heavy work runs under one machine-wide lease: an ad-hoc
   suite is `workit check --heavy -- <cmd>`, never a hand-made flock.
   A tool warning is a finding: fix it in this PR in the right layer, or record the false positive with evidence; pre-existing ones get their own PR.
5. Prove the feature on its real surface with the project's `verify-<app>`
   skill; none yet? Write one (read the `workit-verify-app` skill's SKILL.md and follow it). Tests show branch behavior,
   not that the feature works. The report carries what you observed: a UI
   change a screenshot or console/network check (chrome devtools or
   agent-browser), an API a quoted real response. App not runnable? Say so
   plainly, never claim success.
6. Commit: `workit git commit -m "<type>: <what>" -- <paths>` (or `--all`).
   No endpoint named? Stop here and state the next command. Hand delivery to
   ship, which pushes and opens the PR with its body shape (read the `workit-ship` skill's SKILL.md and follow it), only
   when that was requested, or the request implies delivery and the effective
   endpoint in `workit grant show` is `pr`, `green` or `merged`; `green` and
   `merged` keep babysitting. Else `commit`.
7. Verify as far as the review lane asks (`workit policy assess`, `workit pr
   status`). Lane none: no verdict. Lane self: after `workit check test` passes,
   record `workit ledger verdict tests-verified --self --how "<what you ran>"`;
   it reads self-reviewed, never verified, and is enough. Focused, full, high
   risk or `verification: self|independent` merges: one fresh verifier per PR after the last push, its own host-derived session (Claude Code: the `verifier` agent with the `model` (and `effort`) of `workit models show --role verifier`; Codex:
   the `verifier` agent; OpenCode: a child session; Pi: a supervised worker),
   never a hand-minted id. Before saying done, reconcile
   every named deliverable against the target checkout and observe it (for a push:
   `workit verify-delivery push`).

Independent slices: fan them out (read the `workit-fanout` skill's SKILL.md and follow it).
One `implementer` slice: `workit fanout worktree create <slice>` before spawning,
then `workit fanout brief <slice>`; hooks confine it.

Stay inline by default (`delegation: inline-first`). Hand off only past the thresholds: an explorer after about 3 tool calls or 10k tokens
of searching, parallel writers for 2 or more disjoint units of about 100+
lines each.

## Example

Bad: "Done - added the --since flag, tests pass." (no check ran this turn; the
flag was never invoked)

Good: "Added `--since`. measured: `workit check test` exit 0;
`mytool log --since 2d` printed 3 entries against the fixture repo. inferred:
the GitLab path behaves the same (not run). Handed to the verifier agent."

## Check

```sh
workit check test   # then, when the endpoint was a push or beyond: workit verify-delivery push
```
