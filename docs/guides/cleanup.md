# Cleanup

A finished change should leave nothing on disk. Workit removes what a merged
branch left behind, and `workit gc --worktrees` sweeps what older changes left.
It never forces anything: work that is uncommitted or not merged stays where it
is, and the output names it.

## Where worktrees live

Workit makes worktrees under the managed root, never next to the project:

```text
$XDG_CACHE_HOME/workit-wt/<repo>/<slice>     (default: ~/.cache/workit-wt/<repo>/<slice>)
```

Older Workit versions put them beside the project, in `<repo>-wt/` or
`workit-wt/`. Those are still swept (see below).

## After a merge

When `workit pr merge` lands a PR and deletes its remote branch, Workit also:

1. removes the branch's worktree, if it is clean and Workit made it (under the
   managed root, or by `workit fanout worktree create`);
2. deletes the local branch, once nothing has it checked out;
3. writes a `cleanup.removed` ledger row that lists the removed worktree and
   branch.

`workit verify-delivery merge` does the same once it confirms the merge and
the remote no longer has the branch, so a PR merged on the forge's website is
cleaned up too.

Some things are always kept, and the merge output says why:

- A worktree with uncommitted changes. The output names the changed paths.
  Commit, move or discard them, then run `workit gc --worktrees --apply`.
- A local branch with commits that were not part of the merge.
- The main checkout, the checkout you ran the command in, and any worktree that
  Workit did not make.
- A branch the merge kept on the remote: a stack parent, a fork's branch, or a
  merge run with `--keep-branch` or workspace `deleteBranch: false`.

## Sweeping leftovers: `workit gc --worktrees`

```bash
workit gc --worktrees           # dry run: list what would go, with sizes
workit gc --worktrees --apply   # remove it
```

The command looks at every worktree in `git worktree list` and lists one for
removal only when all of these hold:

- It is in a Workit location: the managed root, a legacy `<repo>-wt/` or
  `workit-wt/` directory beside a project, or the temp directory (scratch
  worktrees). A worktree elsewhere qualifies only if
  `workit fanout worktree create` made it.
- Its commit is on the trunk. That means either merged normally, or
  squash-merged with the whole branch diff equal to one trunk commit.
- It has no uncommitted changes and is not locked.
- It is not the main checkout or the checkout the command runs in.

Registrations whose directory no longer exists are listed as `stale`, and
`--apply` prunes them.

With `--apply`, Workit removes each listed worktree with
`git worktree remove`, deletes its local branch, and deletes the legacy `-wt`
directory or managed `<repo>` directory if that leaves it empty. It also
deletes local branches whose remote branch is gone (`git fetch --prune`
reports them as `[gone]`) and whose commits are on the trunk. A gone branch
that is not merged is kept and listed. Everything removed goes into one
`cleanup.removed` ledger row.

Everything not listed for removal is reported as `kept` with the reason. For
merge checks, the trunk is the remote's default branch as last fetched, so run
`git fetch --prune` first to see recent merges.

## Not covered yet

Dev servers and compose stacks that a change started are not tracked or
stopped yet. They need a process registry (#328).
