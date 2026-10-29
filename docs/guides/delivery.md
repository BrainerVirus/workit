# Delivery and stacks

The delivery verbs do the mechanical part of shipping and record what they
observed in the run ledger. Each one checks the workspace
[grants](grants.md) where it applies; a host deny always wins.

Grants are read for the folder the verb runs in, while git follows
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and
`GIT_NAMESPACE`. With any of them set, the grant-gated verbs (`git push`,
`release start|finish|publish`, `pr create|merge|ready|edit`,
`stack sync|restack|land`, `ci rerun`) refuse with `git_env_redirect`
and name the variables: unset them, or `cd` into the repository and run the
verb there. Read-only verbs still run under them, so a dotfile repository
keeps working. The shell hook likewise denies a raw `git push` that one of
these points at a protected branch, or at a repository it cannot read
(`GIT_DIR=$X git push`). A folder whose `.git` is a `gitdir:` file or a
symlink into another checkout's repository is capped at that checkout's
grants, and at none when no checkout owns the git directory (a
`--separate-git-dir` repository). The same holds when the git directory's
`refs`, `objects`, `config`, `packed-refs`, `commondir`, `info` or `hooks`
resolve into another repository, and a repository with no `.git` entry
(bare, or a bare-style folder) gets no grants.

## Branch, commit, push

```bash
workit git branch feature/x [--base <b>] [--track <t>]   # policy-checked name, from the fetched default target
workit git branch --kind feature|bugfix|release|hotfix --slug <s>   # the kind picks the base (per preset, below)
workit git commit -m "feat: x" -- <paths>       # convention-checked; --all takes every change
workit git commit --amend (-m <msg> | --no-edit) # reword or extend the last commit; -F <file|-> reads the message
workit git commit --allow-empty -m "chore: retrigger"
workit git push [--set-upstream] [--force-with-lease]
workit git push --release main [--release develop] [--release v<version>]   # finish a release or hotfix (release grant)
```

### Branch kinds per preset

Where a branch starts and its PR lands when `--base` (or `pr create --base`)
is left out, per branch-policy preset:

| Kind                  | git-flow                        | github-flow | custom                                                         |
| --------------------- | ------------------------------- | ----------- | -------------------------------------------------------------- |
| `feature/`, `bugfix/` | develop → develop               | main → main | default target → default target, if the policy allows the kind |
| `release/`            | develop → main, then merge back | main → main | the same, if allowed                                           |
| `hotfix/`             | main → main, then merge back    | main → main | the same, if allowed                                           |

github-flow allows any name, so every kind (and any other name) starts from
and lands on main; trunk-based does the same on its trunk. custom starts every
allowed kind from its default target (`vcs.defaultTargetBranch`, else
`develop`) and refuses a kind its `allowed` patterns do not cover, naming its
own kinds (`custom: task/*` suggests `task/x`, never a git-flow kind). Only
git-flow refuses an explicit base or PR target (below) and reminds about
merging back.

The git-flow route in detail:

| Kind                  | Starts from | PR lands on | Then                                           |
| --------------------- | ----------- | ----------- | ---------------------------------------------- |
| `feature/`, `bugfix/` | develop     | develop     |                                                |
| `release/`            | develop     | main        | merge main back into develop, tag `v<version>` |
| `hotfix/`             | main        | main        | merge main back into develop, tag `v<version>` |

develop is the workspace's `branchPolicy.developBranch`, else the default
target when it is not the production branch, else `develop`; production is
`main`, else `master`. A positional name routes by its prefix
(`workit git branch release/4.1.0`). Once develop exists, an explicit
`--base` or PR `--base` that is the other long-lived branch is refused
(`gitflow_base` / `gitflow_target`: a feature from main, a hotfix from
develop); a release or hotfix PR into develop (the back-merge) is allowed, and
a stack parent stays a valid base. github-flow, trunk-based and custom route
every kind to the default target; [release tracks](configuration.md#release-tracks)
take precedence over all of this.

`pr create` on a release or hotfix branch reminds you to merge back into
develop; `pr merge` of one into main reports `merge back` (`mergeBack` in
`--json`). `pr create --base develop` on the same release or hotfix branch
opens the back-merge PR: an open PR is reused only when both its head and its
base match (a forge reply without the base field is matched on head alone).
Once a branch has open PRs into two bases, `pr status`, `pr merge` and the
other PR verbs without `--pr` refuse with `ambiguous_pr`, naming both, rather
than pick one.

A name with a prefix the policy does not allow is refused with that policy's
allowed kinds and the closest of them (git-flow: `fix/` → `bugfix/`, `chore/`,
`docs/`, `refactor/` → `feature/`; custom: the nearest of its own kinds, else
its first). `--kind chore` suggests the closest kind the policy allows; when
the policy's kinds are not ones `--kind` takes (a custom `task/*`), it names
the branch to pass instead, and github-flow says any non-protected name works.

### Releases: start, finish, publish

`workit release` runs a git-flow release or hotfix without the git-flow
binary, with `git flow release finish` semantics. The release branch stays
local: the version bump, changelog, docs and late fixes are ordinary
`workit git commit`s on it.

```bash
workit release start 1.4.0 [--hotfix] [--track <t>]   # release/1.4.0 from develop (hotfix/ from main), local only
workit git commit -m "chore(release): 1.4.0" -- package.json CHANGELOG.md
workit release finish [1.4.0] [--track <t>] [--dry-run]
workit release publish [1.4.0]                         # opt-in: the only verb that pushes the release branch
```

`start` refuses while another release (or hotfix) of the same line is open
(`release_exists`), when the tag already exists, and when the local base has
commits its remote lacks (`base_unpushed`); it branches from the fetched
remote base and records `release.started`.

`finish` first checks: no merge or rebase in progress, no uncommitted changes
to tracked files, production and every merge-back branch not behind their
remote (`branch_behind`; a missing local branch is created from the remote)
and ahead of it only by this release's own merges (`branch_ahead`: the push
would publish other unpushed commits),
the release branch not behind its published copy, the tag free locally and on
the remote (`tag_exists`), and the `release` and `push` grants (`--dry-run`
stops here and lists each step as done or todo). Then, each step recorded as a
ledger row:

1. `git merge --no-ff` of the release branch into production
   (`release.merged`);
2. an annotated tag `<prefix><version>` on that merge, its message the
   version's `CHANGELOG.md` section (`## [1.4.0]`, `## 1.4.0` or
   semantic-release's `# [1.4.0](…)`), else `Release <version>`
   (`release.tagged`);
3. `git merge --no-ff` of the tag into develop and every merge-back branch of
   the track (`release.merged_back`): git-flow merges back through the tag;
4. `git branch -d` of the release branch (`release.branch_deleted`);
5. the atomic `workit git push --release` of production, the merge-back
   branches and the tag (`release.pushed`). The release branch is never in
   it; a published one is deleted on the remote at the tip it had, as
   git-flow does;
6. a GitHub or GitLab release on the tag with the changelog section
   (`release.forge_released`; none for a local-path remote);
7. `verify-delivery released` on the tag (`delivery.verified`), then
   `release.finished`.

As in git-flow, a hotfix finished while a release branch is open merges back
into that release branch instead of develop (the release carries it there);
the release branch is still never pushed. A workspace whose branch policy sets
`integration: "pr"` gets a warning before anything merges that the remote may
require pull requests on production.

An interrupted finish (a merge conflict, a failed push, a forge error) prints
the `resume` command (`workit release finish <version>`). The rerun reads the
repository and the ledger: a merge already in production, an existing tag, a
merge-back branch that already holds the tag and a deleted branch are skipped,
and an existing forge release is found rather than created again. On a merge
conflict, resolve it and `git merge --continue` first.

The tag prefix is git-flow's `gitflow.prefix.versiontag` (empty means bare
`1.4.0` tags), else `v`; a
release track adds its `tagNamespace` (`nun/v1.4.0`). On a release track
(`--track`, or the checkout's), the branch follows the track's naming
(`release/nun-{version}`), starts from its integration branch, lands on its
production branch and merges back into its `mergeBackBranches` (default: its
integration branch).

Outside git-flow (github-flow, trunk-based, custom, or a track whose
`strategy` is not gitflow) the trunk moves only through review, so `finish`
pushes the release branch and opens a release PR into the trunk instead; tag
the merged commit and push it with `workit git push --release <tag>`.

### Release push

`workit git push` never pushes a protected branch. Finishing a release or
hotfix can need protected branches and the release tag on the remote, so
`workit git push --release <ref>` (repeat `--release` for each ref) pushes:

- in git-flow, the production and develop branches (and a git-flow release
  track's production, integration and merge-back branches); in github-flow,
  trunk-based and custom, no branch (a protected trunk moves only through a
  reviewed PR); and release tags (`v<digit>…`, or `<prefix><digit>…` when
  `gitflow.prefix.versiontag` is set, empty included; a track's tags start
  with its `tagNamespace`, e.g. `nun/v1.0.0`) in every preset whose commit is
  already on the remote production branch (git-flow production, a track's
  production, else the default target) or on a branch in the same push
  (`tag_unreleased` otherwise). Any
  other branch or tag is refused (`release_push_refused`, with a preset's own
  unblock);
- branches fast-forward only (never forced, `non_fast_forward` otherwise), and
  a tag only when the remote lacks it or already has it at that commit
  (`tag_exists`: a release tag never moves);
- in one atomic push, then verifies every remote tip and records one
  `release.pushed` ledger row.

It needs the `release` grant (off by default; `workit grant set <workspace>
release=true` from your own terminal) and the `push` grant with its account
check. Inside a Workit workspace, every host's pre-shell hook denies a raw
`git push` onto git-flow main or develop and a raw tag push (`git push origin
v1.0`, `refs/tags/…`, `--tags`), naming this command and the grant;
`--follow-tags` is left alone. Outside git-flow a raw push of the trunk gets
the plain protected-branch deny. `--mirror` is denied. A raw push that would
create a branch name the policy does not allow (`HEAD:chore/x`,
`HEAD:refs/heads/chore/x`, `-u origin chore/x`, the current branch, or any
local branch under `--all`/`--branches`) is denied with the allowed kinds and
the closest name; a branch the remote already has (a legacy or bot branch),
and a delete (`--delete`, `:chore/old`), is never judged.

- `git branch` and `git commit` apply the workspace branch and commit policy,
  never commit to a protected branch, and never sweep in changes you did not
  name. Commits carry a `Workit-Session:` trailer. An amend keeps the old
  commit's trailers (`--no-edit` keeps the whole message; a new `-m`/`-F`
  message gets the old trailers carried over) and never repeats one.
  `--amend` refuses a commit that is already on the default target or a
  protected branch, and suggests a forced push only when the amended commit
  was on the branch's own upstream. With no configured branch policy,
  the repository's local and `origin` branches pick it (`workit doctor` shows
  `preset: detected (…)`): `develop` means gitflow, `main` alone
  github-flow, `master` alone trunk-based.
- Raw branch creation is checked too: every host's pre-shell hook denies
  `git switch -c|-C`, `git checkout -b|-B`, `git branch [-m|-c]` and
  `git worktree add -b|-B` (attached values like `-bchore/x` too, and
  `git worktree add ../x`, which names the branch `x`) onto a protected or
  off-policy name, in any `&&`/`;`/`|` chain, after `cd` or `git -C`, behind
  env assignments or wrappers, quoted or not, from a subdirectory or a linked
  worktree (the directory git runs in picks the workspace policy). Only new
  names are judged: a branch that already exists there (`git branch -f
legacy HEAD`) is not. A command that changes into a directory is judged
  only when that directory already exists in a Workit workspace, so a scratch
  repository (`cd "$(mktemp -d)"`, `git init x && cd x`, a fresh clone) is
  left alone. A Claude Code
  worktree-isolated subagent, which must use plain git, gets the allowed kinds
  and bases in its start context.
- A plain `git commit` gets the same trailer from a `prepare-commit-msg`
  hook, for agents that cannot run `workit git` (a Claude Code
  worktree-isolated subagent). `workit doctor` warns (`session_hook`) when a Workit workspace
  lacks it; `workit doctor --fix` installs it, and only in a Workit workspace.
  See [the session hook](#session-trailer-hook).
- During a rebase, merge, cherry-pick or revert, `git branch`, `git commit`
  and `git push` refuse and say how to continue or abort it. `git commit` is
  allowed where a commit is the next step: an interactive rebase stopped at
  `edit`, and a revert or merge without conflicts (`--no-commit`).
- A failing hook's output is kept whole (head and tail past 200 lines, lines
  cut at 1000 characters).
- `git push` never pushes a protected branch and succeeds only when the remote
  tip equals the local SHA afterwards. It forces only with
  `--force-with-lease`, leased on the tip Workit itself last pushed (otherwise
  `--expect <sha>`), and refuses to drop remote commits you never had unless
  you pass `--overwrite-unintegrated`. When the push is rejected because you
  amended or rebased commits that were already pushed, it says to push with
  `--force-with-lease`, not to fetch and rebase. Content that only matches by
  patch (no merge commits) is named in the advice but still needs
  `--overwrite-unintegrated`.
- Before a push to GitHub or GitLab, `git push` checks that the forge login is
  the workspace `vcs.account`, within 5 seconds in total. Evidence against the
  account blocks the push: the forge names another account, gh has no login
  for it, the credential is rejected, or `vcs.tokenFile` is broken. When
  gh/glab is missing, slow or offline, or the remote is another forge
  (Bitbucket, Gitea, an ssh alias workit cannot resolve), git pushes anyway
  and prints `warning: identity check skipped: <why>` on stderr (`warnings`
  in `--json`); the `push.verified` ledger row records the outcome under
  `identity`.

### Session trailer hook

`workit doctor --fix`, run inside a Workit workspace, writes a helper script
to `<git-common-dir>/workit/session-trailer.sh` and installs a
`prepare-commit-msg` hook that runs it, so a plain `git commit` gets
`Workit-Session: <id>`. Outside a configured workspace it writes nothing, and
plain `workit doctor` only reports (`session_hook`) whether the hook is there
and how to fix it.

- Git runs the hook for `-m`, `-F`, amend, merge and squash commits, also
  with `--no-verify`, and before `commit-msg`, so a commitlint there sees the
  trailer. Your own `commit-msg` checks keep running unchanged.
- The id comes from the same variables `workit` reads: `WORKIT_SESSION_ID`
  (set it empty to opt out), then `OPENCODE_SESSION_ID`, `PI_SESSION_ID` or
  `CODEX_THREAD_ID` (see [hosts](hosts.md)). Cursor puts no session id in the
  agent's shell, so its raw commits get a trailer only when the command sets
  `WORKIT_SESSION_ID`.
- The message is left unchanged with no session; an id outside
  `[A-Za-z0-9_.:@/+-]` (1-128 characters); a plain editor commit (`git commit`
  with no `-m`/`-F`: an emptied buffer must still abort); a commit template
  (`commit -t`, `commit.template`: an unedited one must still abort); a
  comment-only message; and during a rebase or cherry-pick (the replayed
  commits keep their own trailers).
- One edge remains: `git commit -e -m …`, `git commit --amend` and
  `git merge -e` open the editor with the trailer already in the buffer, so
  deleting the subject but leaving the trailer commits a trailer-only message
  instead of aborting.
- The same session's trailer is never added twice (amend, merge, squash, a
  `workit git commit`); another session amending a commit adds its own, as
  `workit git commit --amend` does.
- The hook goes where git looks for hooks (`core.hooksPath` included), and
  only into an empty `prepare-commit-msg` slot or over Workit's own older
  hook. Another tool's hook there is never renamed or edited: `--fix` still
  writes the helper, and the check names the one line to add yourself, which
  runs the same helper and does nothing (silently) in a clone without it, so
  a committed husky hook does not bother teammates who never ran `--fix`:
  `h="$(git rev-parse --git-common-dir 2>/dev/null)/workit/session-trailer.sh"; [ ! -f "$h" ] || sh "$h" "$@" || true`.
  With husky 9 it goes in `.husky/prepare-commit-msg`; with husky 4-8, in the
  hook itself. With lefthook, once it manages `prepare-commit-msg`, the check
  prints a job to merge into that hook's `jobs:` list. That job has no
  double quotes (lefthook on Windows passes `run:` to `sh -c "…"` unescaped)
  and passes `'' {2} {3}` instead of `{1}`: lefthook pastes `{1}` in raw,
  and from a linked worktree it is an absolute path that may hold a space or
  a quote. The helper then finds the message file itself (`COMMIT_EDITMSG`,
  plus `MERGE_MSG` for a merge). Once the line is there, the check
  passes and names who runs it. A `lefthook install` that does not manage
  that slot leaves the Workit hook in place.
- No hook is written when the hooks directory is outside the repository (a
  global `core.hooksPath`) or in the working tree without being ignored; the
  check gives the line to add by hand.
- A relative `core.hooksPath` resolves per worktree, so each linked worktree
  needs its own `--fix`; the default `.git/hooks` and the helper are shared by
  all of them.
- The hook and helper are POSIX `sh`; Git for Windows runs them with its
  bundled `sh`. There is no uninstall verb: delete the `prepare-commit-msg`
  hook (its header names Workit) and the helper.

## Pull requests and CI

```bash
workit pr create (--title <t> [--body-file <f|->] | --fill) [--base <b> | --track <t>] [--issue <#n|ID|url>]… [--refs] [--label <l>]… [--reviewer <login>]… [--draft]
workit pr status [--pr <n>] [--json]   # checks, failing log tails, threads, behind-base, verdict, next, the command for it, babysit step
workit pr ready [--undo]               # mark the draft ready (or back to draft)
workit pr edit [--title <t>] [--body-file <f|->] [--add-label <l>]… [--remove-label <l>]… [--add-reviewer <login>]… [--base <b>]
workit pr threads                      # unresolved review threads, one line each with its id
workit pr reply --thread <id> [--body-file <f|->] [--resolve]
workit ci wait [--timeout 20m]         # exit 0 green, 1 red, 3 conflicts/closed, 4 still pending
workit ci rerun --failed --reason flake|infra   # once per PR head without --force
workit ci logs --failed                # each failing check of the PR head with its job log's last 60 lines
workit pr merge [--method squash|merge|rebase] [--delete-branch | --keep-branch] [--unverified --reason <why>] [--base-red-ok --reason <why>]
workit verify-delivery [push|pr|merge|release]  # exit 1 when it did not land
```

- `pr create` requires the branch to be pushed and checks the forge reports
  that SHA as the PR head. It ends with a `next:` line (`next` in `--json`):
  a non-author verifies the head, then what the effective endpoint does
  (stop, babysit, or land after verification).
- `pr create --fill` takes the title from the oldest commit and the body from
  the commit messages (one commit: its body; several: each subject with its
  body), leaving out Workit's `Workit-Session:` trailer. `--body-file -` reads
  the body from stdin.
- `pr status` prints the command that clears `next` on a `do:` line
  (`nextHint` in `--json`), e.g. `workit pr ready --pr 12` for a draft.
- `pr ready`, `pr edit` and `pr reply` need the `pr` grant and an open PR.
  `pr edit --base` takes a plain branch name and retargets only to the
  branch's default target (from the release track that owns the PR's current
  base; an undetermined line refuses) or to its stack parent (the base
  `workit git branch` recorded, or the branch below it in its stack, never a
  descendant or sibling), never to another protected branch. Labels and
  reviewers are checked before any write: no commas, GitLab reviewers are
  usernames, and a GitHub `org/team` must belong to the repository's owner. On GitLab, draft state lives in the title
  (`Draft:`, `[Draft]`, `(Draft)`), and a new title keeps it. `pr reply` acts
  only on an unresolved thread of that PR.
- With [release tracks](configuration.md#release-tracks), the default base of
  `git branch`, the default target of `pr create` and the default trunk of
  `stack plan` come from the track the branch belongs to; `pr merge` onto a
  track's production branch reports the branches to merge back into.
- `pr merge` merges only when `pr status` reads READY, an independent verdict
  is accepted for that head (`workit ledger check`), and the `merge` grant
  allows it, under `merge: true` and `merge: "verified"` alike. The merge call
  carries the head SHA, so a moved head is refused. Only `merge: true` accepts
  `--unverified --reason "<why>"`, which merges without a verdict and records
  a `merge.unverified` ledger row, but never over a current independent
  failed verdict ([grants](grants.md#merging)). `type-check-only` never
  satisfies the gate.
- `pr merge` ends one of two ways. A merge exits 0 and prints
  `merged PR #<n> (<method>) at head <sha> -> <merge sha>` first, on stdout.
  Anything else exits non-zero and ends with
  `workit: error: PR not merged (<reason>, exit <n>)` on stderr, after the
  refusal and its `unblock:` line, whether the verb refused it or the
  command line did (an unknown option is `invalid_input`, exit 2). The reason
  is the refusal code, such as `not_ready` (checks still running, behind
  base) or `needs_verdict`. `pr create`, `stack land` and `git push` end a
  non-zero exit the same way, with `PR not created`, `stack not landed` and
  `not pushed`. A
  forge that accepts the merge while the PR stays open (a merge queue or
  auto-merge holding it) is `merge_unverified`, exit 1, and
  `workit verify-delivery merged --pr <n>` confirms it later. A filter such as
  `2>&1 | grep -E '^merged|error'` keeps both lines; check the exit code too.
  Under `--json` the envelope's `ok` and `code` carry the same outcome. Every
  Workit verb that exits non-zero prints at least one line saying so.
- `pr merge` deletes the head branch after a successful merge, unless
  `--keep-branch` or the workspace says `deleteBranch: false` (set with
  `workit workspace set <name> deleteBranch=false`; default `true`).
  It keeps the branch, with one `kept <branch>: <why>` line and the merge
  unaffected, when the branch is protected or the PR base or default target,
  the PR comes from a fork, another open PR targets the branch (a stack
  parent), or the PR's author is not the workspace's `vcs.account`; so does a
  forge answer it cannot read. After the remote delete it deletes the local
  branch when it is not checked out anywhere (and holds only merged commits),
  and removes a clean worktree that `workit fanout worktree create` made on
  it; a dirty one is kept and named. An explicit `--delete-branch` refuses a
  protected or base branch before merging. `stack land` never deletes.
- `pr merge` also reads the CI of the base branch's head (a protected target
  only). A failing check there refuses the merge (`base_red`, exit 3), naming
  the failing checks and the run URL, so a PR never lands silently on a red
  base. Checks still running only print a note, and a base with no checks or
  green checks merges quietly. `--base-red-ok --reason "<why>"` overrides it
  and records the reason in the `pr.merge.intent` and `pr.merged` rows; one
  `--reason` serves it and `--unverified` together. `stack land` takes the
  same `--base-red-ok --reason` and passes it to every merge it makes.
- `verify-delivery` answers "did it land?" from the remote, never from local
  state.
- `ci wait --timeout` bounds the whole command, from resolving the forge and
  checking the account to the last poll. A conflicting PR stops the wait at
  once (`blocked: conflicts`): CI does not run on it.
- `pr status` and each `ci wait` poll record an open PR's checks summary
  (`passing`, `failing` or `pending`) at its head as a `pr.status` ledger row,
  only when it changed, and the PR's state once it is merged or closed (a
  merge in the forge UI included). Hooks read it without calling the forge: under a
  `green` or `merged` endpoint, an agent that stops while those checks are
  failing or pending is continued once with `workit ci wait --pr <n>`
  ([stop control](hosts.md)).
- A forge refusal (HTTP 405/422) shows the forge's own reason, such as "No
  commits between main and feature/x". Network errors and 5xx answers exit 5
  (`unavailable`, retry), not 1.

### Linking issues

`workit pr create --issue <id>` (repeatable) links the PR to issues. A
YouTrack id or URL is a YouTrack issue, an issue URL names its forge, and a
number is an issue on the workspace's GitHub or GitLab tracker
([`issues.provider`](configuration.md#issue-tracker)), else on the PR's forge:

| `--issue`                                                            | Body line                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `#42`, `42`, `https://github.com/o/r/issues/42` on a GitHub PR       | `Closes #42` (`Refs #42` with `--refs`)                   |
| `owner/repo#42`                                                      | `Closes owner/repo#42`                                    |
| `7` on a GitLab MR                                                   | `Closes #7` in the MR description                         |
| `7` on a GitHub PR with GitLab issues (`issues.repo: group/project`) | `Related to: https://gitlab.com/group/project/-/issues/7` |
| `IRPT-74`, `https://you.youtrack.cloud/issue/IRPT-74`                | `Related to: <baseUrl>/issue/IRPT-74`                     |

A closing keyword does not cross forges, so an issue on the other forge is a
`Related to:` line with its URL.

- Without `--issue`, a [fanout](#parallel-slices-fanout) slice's `issue`
  links by itself, else the branch name does when the workspace tracker has
  `link: true` ([issue tracker](configuration.md#issue-tracker)), as before.
- Each link of a PR the command opened is a `pr.linked` ledger row, and
  `pr status` lists them (`issues:` line, `issues` in `--json`). A PR that
  was already open keeps its body: the output says so and names
  `workit pr edit`.
- With `backlink: true` the PR URL is commented on each linked issue, at
  most once per PR, with the workspace's verified forge credential or the
  YouTrack API (which needs `WORKFLOW_YT_WRITE=1` like `workit youtrack note`).
  An issue on another forge host is not commented on; it is reported as
  `skipped` with a note.

### Babysitting a PR

With a workspace `defaultEndpoint` of `green` or `merged`
([grants](grants.md#default-endpoint)), an agent that opens a PR keeps
babysitting it without asking. `pr status` names the step in `babysit`:

| `babysit`         | Means                                                                                | The agent                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait`            | checks pending                                                                       | runs `workit ci wait`, in the background where the host allows                                                                                      |
| `wait-forge`      | CI done, but the PR is in a merge queue or the forge is still computing mergeability | re-checks `workit pr status` in the background with backoff, at most 5 times, then stops and reports                                                |
| `fix-ci`          | a gating check failed                                                                | one `workit ci rerun --failed --reason flake\|infra` for a clear flake or infra failure; otherwise reproduces with `workit check`, fixes and pushes |
| `address-threads` | unresolved threads or changes requested                                              | lists them with `workit pr threads`, fixes or replies with a reasoned dismissal (`workit pr reply`)                                                 |
| `update-branch`   | conflicts or a rebase the forge requires                                             | rebases its own branch (or `workit stack sync`) and pushes with `--force-with-lease`                                                                |
| `mark-ready`      | a draft with nothing else open (even with a review pending)                          | runs `workit pr ready`                                                                                                                              |
| `ready`           | nothing left for the agent; a human approval may still be pending                    | stops (`green`), or lands with `workit pr merge` once the verdict is accepted (`merged`)                                                            |
| `merged`          | the PR is merged                                                                     | observes it with `workit verify-delivery merge`                                                                                                     |

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
workspace `vcs.account` is `blocked` (exit 3) with a hint. A linked worktree
outside every workspace glob (`~/.codex/worktrees/…`, `../x`) uses the
workspace of the checkout it was added from. A worktree inside a glob takes
that glob's workspace, even when it differs from the main checkout's: the
worktree's own path wins. A remote whose forge differs
from the workspace `vcs.provider` blocks the PR and CI verbs (`forge_mismatch`)
until a workspace with a narrower glob names the right provider.

## Stacks

`workit stack` manages plain base-branch chains (root PR on the trunk, each
child PR on its parent branch) on GitHub and GitLab.

```bash
workit stack plan [--trunk <b> | --track <t>] [<bottom> … <top>]   # record the chain (default: the current branch's)
workit stack status                    # per PR: READY | WAITING | ADVANCE | COMPLETE
workit stack sync [--local] [--dry-run] [--force <branch>]
workit stack restack [--dry-run] [--force <branch>]                # sync, then delete the merged branches locally
workit stack land [--dry-run] [--max <n>] [--base-red-ok --reason <why>]
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
- After a parent PR lands by squash, run `workit stack restack`. A squash
  merge leaves the child carrying the parent's pre-squash commits, so a plain
  rebase onto the trunk would replay them. `restack` reads the merge from the
  forge, rebases the child with `git rebase --onto <trunk> <old parent tip>`
  (only the child's own commits move), lease-pushes it, retargets its PR to
  the trunk, then deletes the merged parent branch locally. It deletes only
  branches the stack recorded, never the trunk or a protected branch, only
  while the local tip is still the head the stack last saw and no worktree
  has it checked out, and only when no commit can be lost: the tip is on the
  trunk, is the head the PR merged at, or is contained in the branch's
  current remote tip. Otherwise it keeps the branch and says why. Each
  deletion prints the sha (`git branch <name> <sha>` restores it) and is
  recorded in the ledger (`stack.branch.deleted`). A failed sync deletes
  nothing. Remote branches are left to the forge's delete-on-merge. Plan the stack (`workit stack plan`) before the parent
  merges: the recorded parent tip is what `--onto` replays from.
- `land` merges the contiguous run from the root whose PRs are READY and
  verified, one at a time through `pr merge`'s gates, and stops at the first
  that does not qualify with a reason (`no_verdict`, `not_ready`,
  `grant_required`, …). Under `merge: true`, `--unverified --reason "<why>"`
  also lands the unverified PRs in that run and records a bypass row for each.

## Parallel slices (fanout)

`workit fanout` records the slices one lead fans out to parallel workers,
shows how each is doing, makes their worktrees, and gates their fan-in. It never spawns agents: the host's own
subagents do that.

```bash
workit fanout plan <plan.json> [--name <n>] [--trunk <b> | --track <t>] [--take-lead]  # register slices; refuse gaps and overlap
workit ledger standing add "<order>" | list | clear [<id>] [--fanout <n>] # the lead's standing orders for every worker
workit ledger standing add --stop ["<note>"] | add --clear [--fanout <n>] # the stop line for running workers, and lifting it
workit fanout brief <slice> [--name <n>] [--mode new|resume] [--attempt <n>]  # the complete worker brief, verbatim
workit fanout status [--name <n>] [--stuck-after 30m] [--offline]        # per-slice dashboard, STUCK, landing order
workit fanout worktree create <slice> [--name <n>]                      # the slice's worktree, scratch dir and node_modules links
workit fanout worktree release <slice> [--name <n>] [--force]           # record git status, then remove it
workit fanout check [<slice>…] [--name <n>] [--base <ref>] [--offline]  # fan-in gate, landing order
```

- The plan file lists slices: `id`, `branch`, `tier` (`mundane`, `standard`,
  `hard`), `scope` (globs: `*`, `**`, `?`, `{a,b}`; a plain path also covers
  what is below it; `.` is the whole repository; escape literal brackets as
  `\[` and `\]`, e.g. `app/\[id\]/page.tsx`, written `"app/\\[id\\]/page.tsx"` in
  JSON; any other backslash is read as a Windows separator, and `\*`, `\?`,
  `\{`, `\}` or a mix of both readings is refused: use `/`), optional
  `owns`, `dependsOn`, `base`, `worktree`, and the brief: `goal`, `acceptance`, `verify`, `forbidden` (plus `reason` (required under the default `delegation: inline-first`, see [configuration](configuration.md#delegation)) and optional
  `context`, `timebox`, and `issue`: one id or a list, linked by the slice's
  `pr create`). The shape is in the fanout skill's
  `references/brief.md`. It is stored in `<git common dir>/workit/fanouts/`,
  shared by every worktree, and each plan appends a `fanout.planned` ledger
  row.
- The trunk is `--trunk`, else the plan's `trunk`, else, with
  [release tracks](configuration.md#release-tracks), the PR target of the
  checkout's line, as for `stack plan`. When the line cannot be told apart
  `plan` is `blocked` until you pass `--track <name>` or `--trunk`. Without
  tracks it is origin's default branch, else `main`.
- One lead owns a plan: re-planning overwrites the file without a lock.
  Each slice records a `hash` of its definition: goal, acceptance, verify,
  forbidden, scope, owns, branch, base and dependencies, but not tier, reason,
  timebox, context, issue or the worktree path. A re-plan that leaves a slice's hash
  unchanged continues its run; one that changes it starts a new run for that
  slice alone, so ledger rows from before the change no longer link a merged
  PR to it or count as its worktree. Liveness (`STUCK`, last activity) still
  reads every row on the branch, and editing one slice never unlinks a merged
  sibling. A new plan (not a re-plan) under a name that still has standing
  orders in force warns and lists them, with `workit ledger standing clear
--fanout <n>` to drop them if they belong to an earlier run.
- `"fanIn": "integration"` is the one-PR mode: the trunk is an integration
  branch (planning refuses it on origin's default branch), each worker merges
  the integration tip into its branch before reporting, and the lead lands
  slices with fast-forward merges, then ships the integration branch as one
  PR. The default, `"prs"`, is one PR per slice, and workers never merge.
- `ledger standing add "<order>"` records a standing order (a `standing` row)
  for the fanout that `--fanout` names, else the one `fanout` commands would
  pick; `add --fanout` must name an existing plan. An order is one line (a
  newline or control character is refused). The plan records its lead, the
  session that first made it (`leadSession`); only that session may add or
  clear orders, and `brief` and `list` count only the orders a lead
  recorded, so no worker, verifier or hand-written row can inject one. `list`
  shows the orders in force; `clear <id>` ends one and `clear` ends them all
  (a `standing.cleared` row).
- Workers already running get each change on their next hooked tool call,
  once: the orders added and the orders cleared since they last looked
  (their brief's orders are not repeated). A worker is a subagent or child
  session of the lead, a session acting as `<lead>:<x>` or `<lead>-w-<slice>`,
  or any session on a slice's branch; the lead itself gets nothing. Claude
  Code and Codex carry it as the pre-tool hook's `additionalContext`, Cursor
  as `agent_message` on its next shell command, OpenCode in the child's
  system context on every model call while the change stands, and Pi on the
  worker's next tool result. A call with nothing new costs two small file
  reads (`<git common dir>/workit/standing/`) and never loads the runtime.
- `standing add --stop ["<note>"]` is the stop line: an order every running
  worker gets on its next tool call telling it to start nothing new, stop
  what it started (dev servers, browsers, watchers), commit only finished
  work and report to the lead now. Briefs rendered while it stands carry it
  too. `standing add --clear` lifts it (only the stop orders; the others
  stay) and tells running workers the stop is lifted.
- Sessions change with each new conversation. A lead that resumes in a new
  session runs `fanout plan <plan.json> --take-lead`: the plan records the
  current session as `leadSession`, keeps the previous lead in `formerLeads`
  (its orders stay in force until the new lead clears them; it can no longer
  add any), and the ledger gets a `fanout.lead.changed` row (`from`, `to`).
  `--take-lead` is refused without a `WORKIT_SESSION_ID` and from a worker or
  verifier id (`<lead>-w-<slice>`, `+try<n>`, `<lead>-v<n>`, or any id with a
  colon: the Claude Code hook's `<lead>:<agent id>` and `--as` ids). A
  re-plan from another session without the flag keeps the lead and notes how
  to take it.
- A plan recorded before lead sessions has `leadSession: null`. Its standing
  orders count from any session, and `standing add` and `clear` fall back to
  refusing the worker and verifier ids above. `--take-lead` gives it a lead.
- `brief <slice>` prints the worker brief: MODE, GOAL, SCOPE (with `owns`,
  branch and base), CONTEXT, ISSUE (when the slice has one), ACCEPTANCE,
  VERIFY, TIER, TIMEBOX (default 30
  minutes), SCRATCH, FORBIDDEN, the fan-in rule, REPORT, the standing orders
  in force, the worker's `WORKIT_SESSION_ID` (`<lead session>-w-<slice>`) and
  the worker rules. MODE is `resume` when the branch exists, else `new`
  (`--mode` overrides; `resume` needs the branch). SCRATCH is
  `<worktree>/.workit-scratch` when the slice's worktree exists, else
  `.workit-scratch/` at the worker's own worktree root; either way
  `info/exclude` hides it from git. `--attempt <n>` (1-9) renders one attempt
  of a race on branch `<branch>-try<n>` (refused when another slice has that
  branch), worktree `<worktree>+try<n>` and session `<lead>-w-<slice>+try<n>`.
  The lead needs a `WORKIT_SESSION_ID` (it refuses without one); a worker id
  longer than 128 characters hashes its slice part.
- Slices are independent PRs off the trunk by default. A slice with exactly
  one `dependsOn` is stacked on that slice's branch. Once every dependency
  has landed (a merged PR, or git finds the squashed change on the trunk),
  `worktree create` starts the dependent slice from the trunk instead of the
  dependency's pre-squash tip, says so in a note, and its brief names the
  trunk as the base. `check` then diffs such a child against the trunk, so a
  landed parent's files never read as edits outside the child's scope.
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
- `worktree create` (on every host; Claude Code's implementer no longer uses
  its native isolation) adds the slice's worktree at its planned path. A new
  slice starts at its base and gets its branch through `workit git branch`
  (branch policy applies); an existing branch is checked out as it is (`MODE:
resume`). It also makes `<worktree>/.workit-scratch`, hidden from git
  through the repository's `info/exclude`, for the worker's temp files.
  Where the main checkout has `node_modules` (also `packages/*/node_modules`)
  that git ignores, the worktree gets its own: relative links such as
  workspace packages (`../../packages/<name>`) and `.bin` entries resolve
  inside the worktree, installed packages link to the main checkout's (about
  20 ms for this repository, no install). Tests in the worktree then import
  its own workspace packages, not the main checkout's. When git does not
  ignore `node_modules`, nothing is linked and a note says so. Nothing is
  linked either when a lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json`) differs between the main checkout and the worktree: a
  stale main checkout would hand the slice the wrong versions. Nor when the
  main checkout's `node_modules` were installed for an older `bun.lock` (it
  was pulled without `bun install`): every top-level package `bun.lock` pins
  must be installed at that version. The output (and `install` in `--json`)
  then names the exact command to run, such as
  `bun install --frozen-lockfile --cwd <worktree>`, and the brief's `INSTALL:`
  line repeats it.
- An implementer subagent is confined to such a worktree by Workit's
  pre-tool hooks (Claude Code; Codex when it names the agent on the tool
  call): its first edit or mutating git command inside one binds it
  (`worktree.bound` ledger row), and afterwards a change outside it is denied
  naming the worktree. Before it is bound, a change outside every Workit
  worktree is denied, so it never edits the lead's checkout. Files outside any
  repository stay host policy. What the lead owns is always denied to it:
  `git worktree add|remove|prune`, branch deletes, moves and force-resets,
  `update-ref`, `symbolic-ref` writes, tag deletes, delete pushes, force
  pushes with a refspec, refspec pushes with `:` or `+`, `git replace|filter-branch|gc|prune|repack|sparse-checkout`,
  `git config` and `git remote` writes, `git stash drop|clear`, and `workit
fanout plan|worktree` (also behind `--json`, `--cwd`, `--session`). A
  command whose writes Workit cannot read (`python -c`, `node -e`, `xargs rm`,
  `find -delete`) counts as a change in the directory it runs in, and a link
  inside the worktree may not point outside it. After a `cd -`, `cd "$VAR"` or
  `popd` Workit cannot follow, a write is denied until it names an absolute
  path, `git -C <worktree>` or `workit <verb> --cwd <worktree>`. This guards against
  hand edits and is not a sandbox: writers such as `tar -C`, `unzip -d`,
  `curl -o`, `ed` or `sqlite3` and script files an interpreter runs are not
  judged, so the merge gate and a non-author verdict still check the diff.
- `worktree release` records the worktree's `git status` in the ledger
  (`fanout.worktree.released`) before anything else, refuses while there are
  uncommitted changes unless `--force`, then removes the scratch dir and the
  worktree with `git worktree remove`. The branch is kept. It removes only a
  worktree that `create` made for this fanout, slice and path, even with
  `--force`: its ledger row says so, no later release removed it, and git's
  admin dir for the worktree (`.git/worktrees/<id>`) holds the random token
  `create` wrote there and has the id and inode the row recorded. A worktree
  removed by hand and re-added at the path has no token, on any filesystem.
  For a row written before the token, `--force` is refused. Never the main
  checkout, a worktree someone else added there, or a plain directory. An
  empty directory that existed before `create` is left in place.

## Heavy checks share the machine

Parallel agents run their checks on one machine. Workit runs each heavy check
under a machine-wide lease, so two test suites never start at once, and on
Linux it gives each one its own memory and CPU limit.

```bash
workit check test                 # heavy by default: waits for the lease, then runs
workit check --heavy -- npx jest  # an ad-hoc command takes the lease only with --heavy
workit check test --no-lease --reason "<why>"  # run it now, outside the lease (for you, not for briefs)
workit lock status                # who holds the lease; `workit lock wait` waits for a slot
```

- **Which checks are heavy.** The named checks `test`, `build` and `packaging` are heavy by
  default; `lint`, `typecheck` and `format` are light and never take the lease
  (`resources.light` in workspaces.json changes the list). An ad-hoc
  `workit check -- <cmd>` takes the lease only with `--heavy`. A raw heavy
  shell command an agent runs (`npx jest`, `npm run test:ci`) is rewritten
  through the lease, or denied with the exact rewrite on Codex and Cursor. A
  chain with heavy parts is denied with each part's lease command, and a
  command a host permission rule names runs outside the lease
  ([verification guide](verification.md#heavy-commands-and-the-lease)).
- **The lease is a queue.** It has `slots` places (default 1) across every
  worktree and agent of the user. A heavy check that finds them taken joins a
  first-come-first-served queue, says where it stands, and prints a status
  line every 30 s (holder, position, elapsed). It waits up to `--wait <dur>`
  (`90`, `90s`, `30m`, `1h`; default `resources.wait`, 30 min); `--no-wait`
  refuses at once. Only `--no-wait` or a real timeout exits 4 (`busy`), naming
  the holders and the queue. `workit lock status` lists holders and the queue.
  A foreground shell tool call (about 2 min on Claude Code and OpenCode) can
  end before a long wait: run long checks in the background. The lease is
  released when the check ends, and a queued check gives up its place when it
  stops waiting, also on Ctrl-C or SIGTERM. Leases are files
  under the Workit state dir (`~/.local/state/workit/leases` on Linux).
- **Stale leases.** A lease stays held while its `workit` process runs. If
  `workit` is killed outright (SIGKILL), the lease stays held while the
  check's process group or scope still has processes, so two heavy checks
  never overlap. The next acquirer reclaims a lease, and says so, once those
  are gone, or when it was taken before a reboot (the kernel boot id on
  Linux, the boot time elsewhere). Where the holder cannot be identified by
  its process start time (macOS, Windows), a lease also ends after the
  check's `--timeout`, or 6 hours without one, plus a minute.
- **Nested checks.** A heavy check started by another heavy check reuses
  that check's lease (`WORKIT_LEASE`) and does not wait for it. On Linux the
  lease must belong to one of the process's ancestors, so a leaked
  `WORKIT_LEASE` cannot skip the queue.
- **The scope (Linux).** If a user systemd manager is running and has the
  `memory` and `cpu` controllers delegated (cgroup v2), the check runs under
  `systemd-run --user --scope -p MemoryMax=<m> -p CPUQuota=<c>` as the unit
  `workit-check-<id>-<pid>.scope`. When the check passes its limit, the
  kernel kills the check alone, not the desktop session. Without such a
  manager (no systemd, not delegated, macOS, Windows), the check runs as
  before and Workit says so once per session. If `systemd-run` itself fails
  to start the scope, the check runs again without one; systemd-run's error
  line is not shown as check output. `workit doctor` starts a throwaway scope and reads
  its cgroup back, so its `heavy_scope` row says whether the limits really
  apply here, not only whether systemd accepted them.
- **`--json`** adds `lease` (`slot`, `waitedMs`, the `holder` it waited on
  with pid, check, cwd and session, `reclaimed`, `inherited`) and `scope`
  (`unit`, `memoryMax` in bytes, `cpuQuota`, or `unit: null` with a
  `reason`). Both are `null` for a check that is not heavy.

Configure it under `resources`. The machine's limits come from the matching
entry of your `workspaces.json`. A repo's `.workit/checks.json` can
only tighten them, so a repo cannot break the machine-wide limit: it can add
`heavy` checks, lower `memoryMax` and `cpuQuota`, and set its own `wait`; its
`slots` and `scope` are ignored with a warning.

```json
{
  "workspaces": [
    {
      "name": "work",
      "glob": "/home/me/work/**",
      "resources": {
        "slots": 1,
        "memoryMax": "40%",
        "cpuQuota": "70%",
        "scope": true
      }
    }
  ]
}
```

```json
{
  "checks": { "test": "npm run test:ci", "e2e": "npx playwright test" },
  "resources": { "heavy": ["e2e"], "memoryMax": "8G", "wait": 900 }
}
```

| Field           | Default                      | Where     | Meaning                                                                |
| --------------- | ---------------------------- | --------- | ---------------------------------------------------------------------- |
| `heavy`         | `test`, `build`, `typecheck` | both      | Named checks that take the lease; a repo only adds to the list         |
| `slots`         | `1`                          | workspace | Heavy checks that may run at once on the machine (1-64)                |
| `memoryMax`     | `40%` of RAM                 | both      | Scope `MemoryMax`: a percent of total RAM, or a size such as `8G`      |
| `cpuQuota`      | `70%` of all CPUs            | both      | Scope `CPUQuota`: a percent of the whole machine, or a CPU count (`4`) |
| `wait`          | `600`                        | both      | Seconds to wait for the lease before exit 4                            |
| `scope`         | `true`                       | workspace | `false` keeps the lease but runs without a systemd scope               |
| `heavyCommands` | none                         | repo      | Extra shell commands the hook gates (`["mvn verify", "task test:*"]`)  |

An invalid field prints a `workit: resources:` warning and keeps the earlier
value, so a typo never turns the lease off. The lease lives in the CLI, so it
works the same on every host (Claude Code, OpenCode, Codex, Cursor, Pi):
each one runs checks through `workit check`.
