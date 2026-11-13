# Cleanup

A finished change should leave nothing on disk. Workit removes what a merged
branch left behind, `workit gc --worktrees` sweeps the worktrees older changes
left, and `workit gc --branches` sweeps their local branches.
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
  `node_modules`, `.workit-scratch`, `dist`, `build`, `bin`, `target`,
  `coverage`, `.turbo`, `.next` or `.cache` are rebuilt by tools, so they never
  keep a worktree. Only ignored files count: a committed `bin/` of scripts is
  part of the branch and is never touched.
  An old `.workit/` directory that an earlier Workit left in the checkout does
  not keep a worktree either, as long as every file in it is one of Workit's
  exact markers: the workspace marker that points at the shared store, the
  moved-store marker, a 2.x task stub, or a generated `.gitignore` (`*`). Any
  other file in it, or a marker with a field Workit did not write, keeps the
  worktree.
  A repo adds its own generated directories in `.workit/checks.json`
  (see [Regenerable directories](#regenerable-directories)).
- A worktree in use: a heavy check holds the machine lease from inside it, or
  another session is working in it (see [In use](#in-use)).
  A fanout worker's scratch dir is not in the worktree at all: it lives in
  `<state>/scratch/<repo>/<slice>` and goes with its worktree (removed only
  when it is a real directory you own there, never through a symlink), so
  Workit never asks a repository to ignore anything.
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
- It is not in use (see [In use](#in-use)).
- It holds finished work: its branch has commits of its own or its remote
  branch is gone, or it is a Workit worktree detached on a trunk commit (what
  is left once its branch merged). A worktree with none of these (a detached
  scratch checkout elsewhere, or a slice a worker has just created) is kept
  until it has gone unused for 24 hours.
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

## In use

Neither merge cleanup nor `workit gc --worktrees` removes a worktree that is in
use, however merged it is. It is kept, with the reason, when:

- a check holding the heavy machine lease (`workit lock status`) runs with its
  working directory inside it;
- another session's live-session marker names it, and that session's process
  still runs: the recorded process id is running and its start time matches
  the recorded one. A quiet session counts as live however old its last
  heartbeat is; only the process ending (or its id being reused) frees the
  worktree. A marker without a process to check (written on another machine,
  or where Workit cannot read a process id) counts for 15 minutes after its
  last heartbeat.

The session running the command never holds a worktree against itself.

## Sweeping branches: `workit gc --branches`

```bash
workit gc --branches           # dry run: list which local branches would go, and why
workit gc --branches --apply   # delete them
```

The command looks at every local branch except the trunk and deletes one only
when its work is provably on the trunk:

- **Merged PR.** Its tip is exactly the head of a PR that was merged into the
  trunk or a long-lived branch. This covers squash merges. The check needs the
  forge; without it (no push remote, no credentials, offline), the output says
  `merged-PR check skipped` and only the git proofs below apply.
- **Every commit on the trunk.** `git cherry` finds no commit missing from the
  trunk by patch id, including a branch with no commits off the trunk at all.
- **Squash proof.** The whole branch diff equals one trunk commit's patch.

A branch is kept, with the reason, when:

- it is the trunk or a long-lived branch of the branch policy: the default
  target, git-flow `develop` and production, every release track's branches,
  and any protected name;
- it is checked out in any worktree, including a host's own isolated worktree
  (Claude Code's `.claude/worktrees/agent-*`, branch `worktree-agent-*`). Those
  directories belong to the host: Workit deletes their branch once nothing has
  it checked out, and never removes the directory;
- it has an open PR;
- its PR was merged into another work branch (a stack parent), not into the
  trunk or a long-lived branch;
- it has a commit that is not on the trunk by patch id;
- it has no commits of its own and was created or moved in the last 24 hours
  (a worker's fresh branch).

With `--apply`, each branch is deleted only if its tip has not moved since it
was checked, and one `cleanup.removed` ledger row lists every deleted branch
with its tip. As with `--worktrees`, the trunk is the remote's default branch
as last fetched, so run `git fetch --prune` first.

Every `workit gc` form refuses an option it does not know (exit 2) and changes
nothing, so a script written for another Workit version never runs the wrong
cleanup.

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
