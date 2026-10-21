# Configuration and storage

## Setup and upgrades

`workit init` is an interactive wizard with a short basic path and optional
advanced setup (workspace hosting and issue tracking, branch and commit
policies, profiles, release tracks). Detected hosts are preselected; it uses
native package/plugin commands, shows changes before applying them, and never
installs host applications or reloads running sessions. Project setup (hygiene
files, gitignore entries) defaults to No.

```bash
workit upgrade                         # read-only preview
workit upgrade --apply --confirm       # back up config, apply, verify installed versions
workit upgrade --cli --apply --confirm # also update a global npm CLI (--hosts=none: CLI only)
workit launch <host> --auto-upgrade -- <host args>   # upgrade before starting a host
```

`--hosts=opencode,cursor,codex,pi` limits the hosts. Backups go to
`~/.local/state/workit/upgrades/`. Local checkout sources and exact version
pins are left alone. `launch --auto-upgrade` refuses to replace plugins loaded
by a running instance; a registry outage starts the unchanged install with a
warning.

## Config files

Global config lives in `~/.config/workit/` (`config.json`, `workspaces.json`,
`vcs.json`, optional `youtrack.json` and `templates/`). Workspaces map path
globs to hosting (GitHub/GitLab), trackers, branch/commit policy and
[grants](grants.md); the narrowest glob wins.

A workspace's `defaultEndpoint` sets how far an unnamed delivery request goes:
`commit` (default), `pr`, `green` (babysit the PR until merge-ready, never
merging) or `merged` (`green`, then merge; needs the `merge` grant, otherwise
it acts as `green`). Set it with `workit grant set <workspace>
defaultEndpoint=<value>`: a step up needs you at a terminal, a step down does
not. An unknown value is reported by `workit grant show` and read as
`commit`. See [Default endpoint](grants.md#default-endpoint).

```json
{ "name": "personal", "glob": "/home/you/projects/personal/**", "defaultEndpoint": "green" }
```

Set it per repository with a narrower workspace: the narrowest glob wins, so
one repository can stop at a PR while the rest of `personal` stops at
`green`. Agents read the effective value with `workit grant show`; you do
not have to repeat it in a host's memory or rules file.

```json
{
  "workspaces": [
    { "name": "personal", "glob": "/home/you/projects/personal/**", "defaultEndpoint": "green" },
    { "name": "infra", "glob": "/home/you/projects/personal/infra/**", "defaultEndpoint": "pr" },
    { "name": "work", "glob": "/home/you/projects/work/**", "defaultEndpoint": "commit" }
  ]
}
```

A workspace's `trailers` (default `true`) says whether commits carry the
`Workit-Session:` trailer. Set `"trailers": false` on a workspace (a work
repository whose history should not name agent sessions) and edit it yourself
in `workspaces.json`: `workit git commit` then writes no trailer and records
the author in the ledger only (`commit.recorded`), so a verdict from the same
session is still refused as the author's, and an amend drops the old
commit's `Workit-Session:` lines. A workspace nested inside another (a repo
workspace under `work`) that does not set `trailers` inherits it from the
nearest enclosing workspace; its own setting wins.

The session hook adds nothing there: `workit git commit` tells it so, and a
plain `git commit` makes it ask `workit git trailers` (prints `on` or `off`).
Without `workit` on PATH the hook cannot ask and still adds the trailer, so
`workit doctor` warns while a Workit hook or helper is installed in such a
workspace and `workit doctor --fix` removes them (only Workit's own; another
tool's hook and the line you added to it stay, and run nothing without the
helper).

`workit pr merge` there sends its own squash message: the PR title and the
branch's commits (at most 100), with `Workit-Session:` lines dropped from each
commit's trailer block. `workit pr merge --subject <s> --body <b>` sets that
squash message in any workspace; the body is sent as given, apart from
`Workit-Session:` lines in its final trailer block.

```json
{ "name": "work", "glob": "/home/you/projects/work/**", "trailers": false }
```

To add your own trailers (Co-Authored-By) in the same commit, use
`workit git commit --trailer "Co-Authored-By: Name <email>"` (repeatable)
instead of amending afterwards.

### Issue tracker

A workspace's `issues` block names the tracker its PRs and MRs link to. Any
forge works with any tracker: a GitHub repository can track its work in
YouTrack, a GitLab one in GitLab issues.

```json
{
  "name": "work",
  "glob": "/home/you/projects/work/**",
  "vcs": { "provider": "github" },
  "issues": { "provider": "youtrack", "link": true, "relation": "closes", "backlink": false },
  "youtrack": { "baseUrl": "https://you.youtrack.cloud" }
}
```

- `provider`: `github`, `gitlab` or `youtrack`.
- `link` (default `false`): with no `--issue`, derive the issue from the branch
  name (`feature/42-login` is `#42`, `feature/IRPT-740-x` is `IRPT-740`; a
  YouTrack id needs a `baseUrl`). A named issue always links.
- `relation` (default `closes`): `Closes #42` or `Refs #42`; `pr create --refs`
  picks `refs` for one PR.
- `backlink` (default `false`): after opening the PR, comment its URL on each
  linked issue (YouTrack, or an issue in the same GitHub/GitLab repository),
  once per PR. Your host's permission prompt for `workit pr create` is what
  allows the comment, as with `workit youtrack note`; a failed comment is
  reported and never undoes the PR.

Older keys keep working and are read as aliases: `youtrack.link_issues: true`
is `{ "provider": "youtrack", "link": true }`, and `issues.link_on_pr` is
`link`. A workspace with only `youtrack.baseUrl` links YouTrack issues you
name but derives none from the branch. See
[delivery](delivery.md#linking-issues) for `--issue`.

### Model per fanout tier

A workspace's `fanout.tierModels` names the model a fanout worker gets for
its slice's TIER (`mundane`, `standard`, `hard`). Give one model name for
every host, or an object keyed by host (`claude_code`, `opencode`, `codex`,
`cursor`, `pi`, plus an optional `default`) where model names differ.
`workit fanout brief` adds a `model:` line under `TIER:`, and `workit fanout
status` names the model next to each slice it lists to spawn
(`spawnModels` in `--json`). A tier or host with no entry, or a value that is
not a name, gets no model line: the fanout skill's TIER guidance applies. A
nested workspace inherits each tier it leaves unset from the enclosing one.

```json
{
  "name": "personal",
  "glob": "/home/you/projects/personal/**",
  "fanout": {
    "tierModels": {
      "mundane": { "claude_code": "sonnet", "opencode": "anthropic/claude-sonnet-4-5" },
      "standard": "opus",
      "hard": "opus"
    }
  }
}
```

The lead's host comes from its environment (`WORKIT_HOST` or the host's own
session variable). Hosts that cannot pick a model per spawn (Codex, Cursor,
Pi) still show it, so you can start the worker on that model yourself.

### Live-session guard

Two agent sessions editing one checkout overwrite each other's work. The
hooks every host already runs record which session last wrote in a checkout
(its session, host, process id and its start time, and a heartbeat, in
`<state dir>/live-sessions/`). When a different session then edits a file
or runs a mutating command there (`git commit`, `switch`, `reset`, `stash`,
`rebase`, a shell redirect, `rm`, `workit git commit` and the like), its
write hook denies it, naming the owning session, its host and how long ago
it was last active. Writes under `.git` count too.

- **What stays allowed:** read-only commands (`git status`, `log`, `diff`,
  `cat`), `git worktree add`, `--help`, `-h` and dry runs (`--dry-run`, and
  `-n` for `add`, `clean`, `rm` and `mv`; `git commit -n` still commits).
- **Where a command runs:** the guard judges the directory each command
  actually runs in: `cd` and `pushd` earlier in the line, `( … )` groups,
  `git -C`, and git run through `bash -c`, `$(…)`, `env`, `eval`, `xargs`,
  `find -exec`, PowerShell or `cmd /c`. So `cd <your worktree> && git
  commit` is allowed from an owned checkout. A directory it cannot know
  (`cd $X`) is skipped, not denied.
- **The owner is never refused**, nor are its subagents and fanout workers
  (ids `<lead>:<agent>` and `<lead>-w-<slice>`), nor any session running in
  the same host process.
- **Each checkout is separate**, so worktrees of one repository each have
  their own owner. Work in a worktree of your own to work next to a live
  session.
- **A marker expires** when the owning process has exited (a reused pid with
  another start time counts as exited), or 15 minutes after its last write.
  The owner rewrites it at most every 30 seconds. Two sessions that claim a
  free checkout at the same instant race: the last write wins, and the other
  session is refused from its next write on.
- **To release a checkout** once you know its session is finished, delete
  the marker file the deny names, or run one command as
  `WORKIT_LIVE_SESSION=override <command>`. The override counts only as the
  leading assignment of a single simple command (not inside quotes, not on
  another command of a `&&` chain), and in a Workit workspace it leaves a
  `live_session.override` row in the ledger.
- **Turn the guard off** per workspace with `"liveSessionGuard": false`. A
  nested workspace inherits the setting.
- **It fails open.** An unreadable or corrupt marker store never blocks a
  write.

```json
{ "name": "scratch", "glob": "/home/you/scratch/**", "liveSessionGuard": false }
```

The guard runs on every host through the hooks it already has: Claude Code
and Codex use `PreToolUse`, Cursor uses `preToolUse` and
`beforeShellExecution`, OpenCode uses its `permission` hook, and Pi uses
`tool_call`. Host limits:

- **Cursor** does not put the parent conversation on a subagent's tool
  events, so the guard recognizes that subagent by the Cursor process it
  runs in, not by its id.
- **Windows** has no process ancestry to read, so a marker records no owner
  process. It lasts until its heartbeat expires, and any session of the same
  host as the owner is allowed, because the guard cannot tell that host's
  subagents, or a session after `/clear`, from another window. On Windows the
  guard therefore only separates different hosts. The same holds anywhere a
  marker's process start time cannot be read.
- **Codex** shell commands are judged in the session's directory. If a
  command carries its own `workdir` and does no `cd`, the guard still judges
  it against the session directory; that per-command `workdir` is not read.
- **Writes the host's hooks never see** are not guarded: an interpreter or
  formatter writing files from a script, or edits made outside an agent.

Two heavy checks on one machine are kept apart separately, by the
[machine-wide check lease](delivery.md#heavy-checks-share-the-machine).

GitHub and GitLab use your `gh auth login` / `glab auth login`; Workit stores
no forge tokens of its own.

## Release tracks

A repository with more than one release line (for example `nun-develop` ->
`nun-master` beside `develop` -> `master`) declares each line under the
workspace's `releaseTracks`. `workit init` (advanced setup) edits them, or
add them to `workspaces.json` yourself:

```json
{
  "name": "ri-web",
  "glob": "/home/you/work/ri/web/**",
  "vcs": { "provider": "github", "account": "you", "defaultTargetBranch": "nun-develop" },
  "branchPolicy": {
    "preset": "gitflow",
    "allowed": ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
    "protected": ["main"],
    "integration": "pr"
  },
  "releaseTracks": {
    "nun": {
      "strategy": "gitflow",
      "productionBranch": "nun-master",
      "integrationBranch": "nun-develop",
      "naming": { "feature": "feature/{name}", "release": "release/nun-{version}", "hotfix": "hotfix/nun-{name}" },
      "baseBranch": "nun-develop",
      "mergeBackBranches": ["nun-develop"],
      "pullRequestTarget": "nun-develop",
      "tagNamespace": "nun/",
      "versionSource": { "kind": "git-tag" },
      "requiredChecks": []
    },
    "standard": {
      "strategy": "gitflow",
      "productionBranch": "master",
      "integrationBranch": "develop",
      "naming": { "feature": "feature/{name}", "release": "release/{version}", "hotfix": "hotfix/{name}" },
      "baseBranch": "develop",
      "mergeBackBranches": ["develop"],
      "pullRequestTarget": "develop",
      "tagNamespace": "",
      "versionSource": { "kind": "git-tag" },
      "requiredChecks": []
    }
  }
}
```

Only `productionBranch` and `integrationBranch` are required; `baseBranch`
and `pullRequestTarget` default to the integration branch, `mergeBackBranches`
to none, and naming to `<kind>/<slug>`.

Every command that needs a target picks the track first, in this order (the
first signal that answers wins):

1. `--track <name>` on `workit git branch`, `workit pr create` and
   `workit stack plan` (an unknown name, or `--track` without configured
   tracks, is an error);
2. the branch is a track's integration, production or base branch (for
   `git branch --base <b>`, the base's track);
3. `WORKFLOW_RELEASE_TRACK=<name>` for a host session (a name this workspace
   does not have is ignored with a note by read-only verbs and blocks
   mutating ones);
4. only one track is configured and the workspace default target is on it;
5. the base `workit git branch` recorded for the branch
   (`git config branch.<name>.workitBase`), followed through stacked parents;
6. the branch reflog's `Created from <branch>` when it names a track branch;
7. for a branch made with plain `git checkout -b` / `git switch -c`, the HEAD
   reflog's `checkout: moving from <branch> to <it>` entry that created it
   (an entry left by an earlier, deleted branch of the same name is ignored; a
   stacked parent is followed through its recorded base);
8. ancestry by fork point: the track whose merge-base with the branch strictly
   descends from every other track's merge-base. Equal or unrelated fork
   points (one line forked from the other, or merges the other in) are
   ambiguous, never decided by commit counts.

When the workspace default target (the workspace `vcs.defaultTargetBranch`,
else its branch preset's, else the global `vcs.json` `defaultTargetBranch`, the
same value the commands, `grant show` and `doctor` use) belongs to no track,
it competes as a line of its own; a branch on it gets no track and today's
defaults.

If none of these decides and there are two or more lines (tracks, plus the
default line when no track owns it), the line is undetermined:
`workit git branch`, `workit pr create` and `workit stack plan` refuse (exit 3,
"can't tell which release line …; pass --track <name> or --base <branch>"),
while `workit grant show` and `workit doctor` only show the note. `--base`
with `--track` on `pr create`, and `--trunk` with `--track` on `stack plan`,
are refused as contradictory.

The resolved track sets the base of new branches (`baseBranch`), the
`--kind`/`--slug` branch name (`naming`; a template without a placeholder, such
as `nun/feature`, is a prefix: `nun/feature/<slug>`), the default PR target and
stack trunk (`pullRequestTarget`), and, after `workit pr merge` lands on a
track's `productionBranch`, the `mergeBackBranches` it reports (Workit does not
open merge-back PRs itself). Every branch any track names is protected in
addition to `branchPolicy.protected`, even when the track itself is malformed,
and naming templates are allowed branch patterns. `workit grant show` and
`workit doctor` list the tracks and the one the current checkout resolves to.
Without `releaseTracks`, nothing changes.

At runtime a malformed or unknown track field is reported (`workit doctor`
warns) and ignored; a track without a usable `productionBranch` and
`integrationBranch` is skipped, and a naming template with no literal text
(`{name}`) is ignored rather than allowing every branch name. A track that
lists a field in its `critical` array (`naming` covers `naming.*`) makes
Workit fail closed when that field is unknown or malformed: the commands
refuse and every branch counts as protected.

**YouTrack** is optional. Everything organization-specific comes from
`youtrack.json`: `baseUrl` (required), `meetingIssue`/`meetingIssues`, an
optional IANA `timezone` (else the process timezone). Comment text comes from
the editable `issue-update` template (`templates/issue-update.md` overrides the
bundled one). Work-item dates are calendar days sent as UTC midnight.

## Task store

Task state lives in the git common directory, `.git/workit/` (shared by every
worktree, kept across worktree removal and `git clean`), or in
`<dir>/.workit/` outside git. Never edit it by hand.

- Each task is an append-only `tasks/<id>/events.jsonl` with a rebuildable
  `snapshot.json`. A crash can only leave a torn last line, which readers
  ignore and the next write truncates.
- Every branch is one implicit task. A detached HEAD is keyed by its worktree,
  a non-git directory by its path. `workit task start` names a branch's task;
  closing frees it.
- A 2.x `.workit/` store migrates on the first CLI command in that checkout
  (backup under `legacy/`, one line printed). Host hooks never migrate; they
  say `workit migration pending — run workit task status`. Migrated tasks keep
  their ids and are unbound: `workit task status --all` lists them and
  `workit task adopt <id>` binds one to the current branch.
- `workit gc` folds long logs into a checkpoint plus their 50 most recent
  events, removes unreferenced blobs, temp files and old check logs.
  `--dry-run` writes nothing; `--prune-recovery --yes` removes 2.x recovery
  copies.

## Locks

A write that meets a live lock holder retries briefly (250 ms in host plugins
and the MCP server, 2 s in the CLI) and then returns the retryable `busy` code
(exit 4). A lock whose owner is gone (dead or reused pid) is reclaimed by the
next write. A lock from another host, container or older Workit version cannot
be checked and is reclaimed after a 10-minute TTL. `workit doctor` warns about
stale locks; `workit doctor --fix-lock` clears one under the same guard, and
`--fix-lock --force --yes` is the escape hatch for an owner that cannot be
verified.
