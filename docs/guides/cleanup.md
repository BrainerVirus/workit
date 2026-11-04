# Cleanup

A finished change should leave nothing on disk. Workit removes what a merged
branch left behind, and `workit gc --worktrees` sweeps what older changes left.
It never forces anything: work that is uncommitted or not merged stays where it
is, and the output names it.

## Where worktrees live

Workit makes worktrees under the managed root in its state dir, never next to
the project. A worktree holds uncommitted work, so it is state, not cache:

```text
<state>/worktrees/<repo>/<slice>   (default: ~/.local/state/workit/worktrees/<repo>/<slice>,
                                    %LOCALAPPDATA%\workit\worktrees\<repo>\<slice> on Windows)
```

`$XDG_STATE_HOME` or `WORKIT_STATE_DIR` moves it with the rest of the state
dir. When another repository with the same name already has worktrees in
`<repo>/`, `workit fanout plan` uses `<repo>-<hash>/` instead, so two checkouts
never share a directory.

Older Workit versions used `$XDG_CACHE_HOME/workit-wt/<repo>/<slice>`
(default `~/.cache/workit-wt/`). Workit never moves those worktrees, because a
session may still be using one. That root stays a managed root: merge cleanup
and `workit gc --worktrees` remove its merged, clean worktrees, and `--apply`
deletes the directory once it is empty. Until then, `workit doctor` reports it
as `info` in the `legacy_dirs` row. Worktrees from even older versions, beside
the project in `<repo>-wt/` or `workit-wt/`, are still swept too (see below).

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
- A worktree holding gitignored files that a tool cannot rebuild, such as a
  `.env` or a local config. The output names them. Ignored files under
  `node_modules`, `.workit-scratch`, `dist`, `build`, `coverage`, `.turbo`,
  `.next` or `.cache` are rebuilt by tools, so they never keep a worktree.
  A repo adds its own generated directories in `.workit/checks.json`
  (see [Regenerable directories](#regenerable-directories)).
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

- It is in a Workit location: the managed root, the old
  `~/.cache/workit-wt/` root, a legacy `<repo>-wt/` or `workit-wt/` directory
  beside a project, or the temp directory (scratch worktrees). A worktree elsewhere qualifies only if
  `workit fanout worktree create` made it.
- Its commit is on the trunk. That means either merged normally, or
  squash-merged with the whole branch diff equal to one trunk commit.
- It has no uncommitted changes, no gitignored files that cannot be rebuilt
  (see above), and is not locked.
- It holds finished work: its branch has commits of its own or its remote
  branch is gone. A worktree without either (a detached scratch checkout, or a
  slice a worker has just created) is kept until it has gone unused for 24
  hours.
- It is not the main checkout or the checkout the command runs in.

Registrations whose directory no longer exists are listed as `stale`, and
`--apply` prunes them.

With `--apply`, Workit removes each listed worktree with
`git worktree remove`, deletes its local branch, and deletes the legacy `-wt`
directory or managed `<repo>` directory if that leaves it empty (and the old
`~/.cache/workit-wt/` root once nothing is left in it). It also
deletes local branches whose remote branch is gone (`git fetch --prune`
reports them as `[gone]`) and whose commits are on the trunk. A gone branch
that is not merged is kept and listed. Everything removed goes into one
`cleanup.removed` ledger row.

Everything not listed for removal is reported as `kept` with the reason. For
merge checks, the trunk is the remote's default branch as last fetched, so run
`git fetch --prune` first to see recent merges.

## Regenerable directories

A build that copies or generates files into gitignored directories leaves them
in every worktree it ran in. List those directories in the repo's committed
`.workit/checks.json`, and cleanup treats their ignored files like
`node_modules`:

```json
{
  "checks": { "test": ["bun", "run", "test"] },
  "cleanup": { "regenerable": ["packages/*/skills", "packages/*/assets"] }
}
```

Each entry is a glob relative to the repository top. `*` matches within one
path segment and `**` across segments; other glob syntax, absolute paths and
`..` are refused. An ignored path is regenerable when it, or any directory
above it, matches an entry. The list adds to the built-in one; it never
removes a built-in name. Cleanup reads it from the checkout it runs in (a
linked worktree without its own `.workit/` reads the main checkout's).

Everything under a regenerable directory goes with the worktree, including a
file a tool would not rebuild: `dist/sub/.env` is discarded, and so is
`packages/x/skills/notes.md` with the entry above. Keep files you want
outside those directories.

A `cleanup` value with the wrong shape (an entry that is not a string, a
`cleanup.regenerable` that is not a list, an unknown key) makes the whole
checks config invalid, as a bad `gates` entry does: `workit check` names
`cleanup.regenerable` and the problem, and cleanup uses only the built-in list
until it is fixed.

## Not covered yet

Dev servers and compose stacks that a change started are not tracked or
stopped yet. They need a process registry (#328).
