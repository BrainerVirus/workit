# Delivery and stacks

The delivery verbs do the mechanical part of shipping and record what they
observed in the run ledger. Each one checks the workspace
[grants](grants.md) where it applies; a host deny always wins.

## Branch, commit, push

```bash
workit git branch feature/x [--base <b>] [--track <t>]   # policy-checked name, from the fetched default target
workit git commit -m "feat: x" -- <paths>       # convention-checked; --all takes every change
workit git push [--set-upstream] [--force-with-lease]
```

- `git branch` and `git commit` apply the workspace branch and commit policy,
  never commit to a protected branch, and never sweep in changes you did not
  name. Commits carry a `Workit-Session:` trailer.
- `git push` never pushes a protected branch and succeeds only when the remote
  tip equals the local SHA afterwards. It forces only with
  `--force-with-lease`, leased on the tip Workit itself last pushed (otherwise
  `--expect <sha>`), and refuses to drop remote commits you never had unless
  you pass `--overwrite-unintegrated`.

## Pull requests and CI

```bash
workit pr create (--title <t> | --fill) [--base <b> | --track <t>] [--draft]
workit pr status [--pr <n>] [--json]   # checks, failing log tails, threads, behind-base, verdict, next and babysit step
workit ci wait [--timeout 20m]         # exit 0 green, 1 red, 4 still pending
workit ci rerun --failed --reason flake|infra   # once per PR head without --force
workit pr merge [--method squash|merge|rebase] [--delete-branch]
workit verify-delivery [push|pr|merge|release]  # exit 1 when it did not land
```

- `pr create` requires the branch to be pushed and checks the forge reports
  that SHA as the PR head.
- With [release tracks](configuration.md#release-tracks), the default base of
  `git branch`, the default target of `pr create` and the default trunk of
  `stack plan` come from the track the branch belongs to; `pr merge` onto a
  track's production branch reports the branches to merge back into.
- `pr merge` merges only when `pr status` reads READY, an independent verdict
  is accepted for that head (`workit ledger check`), and the `merge` grant
  allows it. The merge call carries the head SHA, so a moved head is refused.
- `verify-delivery` answers "did it land?" from the remote, never from local
  state.

### Babysitting a PR

With a workspace `defaultEndpoint` of `green` or `merged`
([grants](grants.md#default-endpoint)), an agent that opens a PR keeps
babysitting it without asking. `pr status` names the step in `babysit`:

| `babysit` | Means | The agent |
| --- | --- | --- |
| `wait` | checks pending | runs `workit ci wait`, in the background where the host allows |
| `wait-forge` | CI done, but the PR is in a merge queue or the forge is still computing mergeability | re-checks `workit pr status` in the background with backoff, at most 5 times, then stops and reports |
| `fix-ci` | a gating check failed | one `workit ci rerun --failed --reason flake\|infra` for a clear flake or infra failure; otherwise reproduces with `workit check`, fixes and pushes |
| `address-threads` | unresolved threads or changes requested | fixes or replies with a reasoned dismissal |
| `update-branch` | conflicts or a rebase the forge requires | rebases its own branch (or `workit stack sync`) and pushes with `--force-with-lease` |
| `mark-ready` | a draft with nothing else open (even with a review pending) | marks the PR ready for review |
| `ready` | nothing left for the agent; a human approval may still be pending | stops (`green`), or lands with `workit pr merge` once the verdict is accepted (`merged`) |
| `merged` | the PR is merged | observes it with `workit verify-delivery merge` |

A branch that is only behind its base reads `ready`: `behindBase` is
information, so a busy base never starts a rebase/CI loop or drops approvals.

`babysit` is `null` for a closed, unmerged PR: the agent stops and reports.
It also stops early for a new consequential choice, a host denial, a review
comment that needs a product decision, a required update that repeats because
the base keeps moving, or after 3 failed fix attempts on the same check.
`green` never merges, and `merged` without the `merge` grant behaves as
`green`.

GitHub is read through `gh api`, GitLab through `glab api`. The forge is
picked from the push remote, and the workspace account's credential is passed
on every call without switching your active login. A login that is not the
workspace `vcs.account` is `blocked` (exit 3) with a hint.

## Stacks

`workit stack` manages plain base-branch chains (root PR on the trunk, each
child PR on its parent branch) on GitHub and GitLab.

```bash
workit stack plan [--trunk <b> | --track <t>] [<bottom> … <top>]   # record the chain (default: the current branch's)
workit stack status                    # per PR: READY | WAITING | ADVANCE | COMPLETE
workit stack sync [--local] [--dry-run] [--force <branch>]
workit stack land [--dry-run] [--max <n>]
```

- The order is stored in `<git common dir>/workit/stacks/`, shared by every
  worktree. One command at a time may change a stack; a second answers `busy`.
- `sync` restacks each remaining branch onto its parent after a merge (squash
  merges always need this), in the worktree that has it checked out or a
  temporary one, never moving your checkout. A restacked branch must carry the
  same change, or it is `blocked` with `content_changed` and stays local
  unless you pass `--force <branch>`. On a conflict, resolve,
  `git rebase --continue`, then `workit stack sync` again. Branches with merge
  commits are refused.
- A restacked branch with the same patch-id and diff keeps its verdict; CI
  always runs again.
- `land` merges the contiguous run from the root whose PRs are READY and
  verified, one at a time through `pr merge`'s gates, and stops at the first
  that does not qualify with a reason (`no_verdict`, `not_ready`,
  `grant_required`, …).

## Parallel slices (fanout)

`workit fanout` records the slices one lead fans out to parallel workers,
shows how each is doing, makes their worktrees on hosts without native
isolation, and gates their fan-in. It never spawns agents: the host's own
subagents do that.

```bash
workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>]   # register slices; refuse gaps and overlap
workit ledger standing add "<order>" | list | clear [<id>] [--fanout <n>] # the lead's standing orders for every worker
workit fanout brief <slice> [--name <n>] [--mode new|resume] [--attempt <n>]  # the complete worker brief, verbatim
workit fanout status [--name <n>] [--stuck-after 30m] [--offline]        # per-slice dashboard, STUCK, landing order
workit fanout worktree create <slice> [--name <n>]                      # the slice's worktree and scratch dir
workit fanout worktree release <slice> [--name <n>] [--force]           # record git status, then remove it
workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline]  # fan-in gate, landing order
```

- The plan file lists slices: `id`, `branch`, `tier` (`mundane`, `standard`,
  `hard`), `scope` (globs: `*`, `**`, `?`, `{a,b}`; a plain path also covers
  what is below it; `.` is the whole repository; escape literal brackets as
  `\[` and `\]`, e.g. `app/\[id\]/page.tsx`, written `"app/\\[id\\]/page.tsx"` in
  JSON; any other backslash is read as a Windows separator, and `\*`, `\?`,
  `\{`, `\}` or a mix of both readings is refused: use `/`), optional
  `owns`, `dependsOn`, `base`, `worktree`, and the brief: `goal`, `acceptance`, `verify`, `forbidden` (plus optional
  `context`, `timebox`). The shape is in the fanout skill's
  `references/brief.md`. It is stored in `<git common dir>/workit/fanouts/`,
  shared by every worktree, and each plan appends a `fanout.planned` ledger
  row.
- The trunk is `--trunk`, else the plan's `trunk`, else, with
  [release tracks](configuration.md#release-tracks), the PR target of the
  checkout's line, as for `stack plan`. When the line cannot be told apart
  `plan` is `blocked` until you pass `--track <name>` or `--trunk`. Without
  tracks it is origin's default branch, else `main`.
- One lead owns a plan: re-planning overwrites the file without a lock.
  Each slice records a `hash` of its own definition (brief, scope, branch,
  base, dependencies). A re-plan that leaves a slice unchanged continues its
  run; one that changes it starts a new run for that slice alone, so ledger
  rows from before the change no longer link a merged PR to it or count as
  its activity in `status`. Editing one slice never unlinks a merged sibling.
  A new plan (not a re-plan) under a name that still has standing orders in
  force warns and lists them, with `workit ledger standing clear --fanout
  <n>` to drop them if they belong to an earlier run.
- `"fanIn": "integration"` is the one-PR mode: the trunk is an integration
  branch (planning refuses it on origin's default branch), each worker merges
  the integration tip into its branch before reporting, and the lead lands
  slices with fast-forward merges, then ships the integration branch as one
  PR. The default, `"prs"`, is one PR per slice, and workers never merge.
- `ledger standing add "<order>"` records a standing order (a `standing` row)
  for the fanout that `--fanout` names, else the one `fanout` commands would
  pick. `list` shows the orders in force; `clear <id>` ends one and `clear`
  ends them all (a `standing.cleared` row).
- `brief <slice>` prints the worker brief: MODE, GOAL, SCOPE (with `owns`,
  branch and base), CONTEXT, ACCEPTANCE, VERIFY, TIER, TIMEBOX (default 30
  minutes), SCRATCH, FORBIDDEN, the fan-in rule, REPORT, the standing orders
  in force, the worker's `WORKIT_SESSION_ID` (`<lead session>-w-<slice>`) and
  the worker rules. MODE is `resume` when the branch exists, else `new`
  (`--mode` overrides; `resume` needs the branch). SCRATCH is
  `<worktree>/.workit-scratch` when the slice's worktree exists, else
  `.workit-scratch/` at the worker's own worktree root; either way
  `info/exclude` hides it from git. `--attempt <n>` (1-9) renders one attempt
  of a race on `<branch>-try<n>` with its own session.
- Slices are independent PRs off the trunk by default. A slice with exactly
  one `dependsOn` is stacked on that slice's branch.
- `plan` exits 2 (`invalid_input`) and lists every empty or placeholder brief
  field, unknown or cyclic dependency and bad glob. It exits 3 (`blocked`)
  when two slices may write the same file. It checks the trunk's files plus
  one sample path per glob and brace alternative (`src/new/**` ->
  `src/new/<any>`, `src/{a,b}/**` -> `src/a/<any>`, `src/b/<any>`), so overlap
  in directories nobody has created yet is caught, and paths that differ only
  in case count as one file. A scope path that differs only in case from a
  trunk file or directory (`src/API` against `src/api`) is `blocked` too. Each overlap comes with a fix: an
  owner (`owns`) for lockfiles, manifests, barrels and CI config, otherwise a
  `dependsOn` that serializes the slices. Overlap between slices that already
  depend on each other, or with exactly one owner, is accepted.
- `check` reads the slice branches as git has them locally (fetch first). Per
  slice it flags files changed since its base outside its scope (a file
  another slice owns counts as outside), conflicts with the trunk, and
  conflicts with each sibling branch from `git merge-tree`. A sibling
  conflict is charged to the slice that lands later. A slice whose
  dependency is not ready waits. Two siblings that change one file under
  different case are flagged too, as is a file a slice adds that the trunk
  spells differently only in case (a case rename that removes the trunk's
  spelling is fine). Merge checks need git 2.38 or newer.
- A slice that already landed is done: `check` and `status` skip it and its
  dependents stop waiting. Landed means its PR merged (squash merges
  included, even after the branch was deleted), asked through `gh`/`glab`.
  A merged PR whose branch is gone counts only when the ledger links the
  branch to the slice: a `worktree create` row made under the slice's current
  hash, or a row such as a verdict recorded on the merged head since that
  hash was first planned. An older branch, or an older fanout of the same
  name, is not taken for it. Without the forge (`--offline`, no CLI, no login, or after
  the first timeout or unavailable answer in a run) git decides: the branch
  tip is on the trunk and its reflog shows a commit made on the branch (a
  branch only fast-forwarded to a newer trunk does not count), or its change
  has the same patch-id as a trunk commit (a squash merge that applied
  cleanly). A landing whose changed paths read on the trunk exactly as before
  it (a revert) is not landed, and the slice's notes say so. Exit 0
  means every checked slice is ready or landed and `next` names the landing
  order: dependencies first, then plan order.
  Exit 3 names the first blocked slice and how to unblock it. The verdict per
  slice is shown; `pr merge` still enforces it.
- `status` reads side effects only, never worker reports. Per slice: the
  branch head and its age, the PR and its CI (when the forge answers), the
  ledger verdict on the current head, and landed. A slice is `STUCK` when it
  started, has no accepted verdict, and nothing moved for longer than
  `--stuck-after`, else its `timebox` (`45 minutes`, `2h`, `1h30m`), else
  30 minutes: no commit or branch update, no ledger row for its branch or
  slice. The
  landing order lists slices with an accepted verdict and, with the forge,
  an open PR whose checks pass, each after the dependencies it waits for;
  `spawnable` lists slices that can start now (every dependency landed, or a
  stacked child whose only open dependency is its verified parent). Without
  `gh`/`glab` it still answers (exit 0), says the forge is off, and its next
  step asks for a PR (`workit pr create`) before any merge.
- `worktree create` (for hosts without native worktrees: OpenCode, Codex,
  Cursor, Pi) adds the slice's worktree at its planned path. A new slice
  starts at its base and gets its branch through `workit git branch` (branch
  policy applies); an existing branch is checked out as it is (`MODE:
  resume`). It also makes `<worktree>/.workit-scratch`, hidden from git
  through the repository's `info/exclude`, for the worker's temp files.
- `worktree release` records the worktree's `git status` in the ledger
  (`fanout.worktree.released`) before anything else, refuses while there are
  uncommitted changes unless `--force`, then removes the scratch dir and the
  worktree with `git worktree remove`. The branch is kept. It removes only a
  worktree that `create` made for this fanout, slice and path (its ledger row
  says so, no later release removed it, and git's admin dir for the worktree
  has the id, inode and birth time the row recorded), even with `--force`; never the main checkout, a worktree someone
  else added there, or a plain directory. An empty directory that existed
  before `create` is left in place.
