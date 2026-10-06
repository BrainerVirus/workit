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
workit pr status [--pr <n>] [--json]   # checks, failing log tails, threads, behind-base, verdict, next action
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
