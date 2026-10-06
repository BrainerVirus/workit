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

Every command that needs a target picks the track first, in this order (the
first signal that answers wins):

1. `--track <name>` on `workit git branch`, `workit pr create` and
   `workit stack plan` (or `WORKFLOW_RELEASE_TRACK` for a host session);
2. the checkout is a track's integration, production or base branch;
3. only one track is configured;
4. the base `workit git branch` recorded for the branch
   (`git config branch.<name>.workitBase`), followed through stacked parents;
5. the reflog's `Created from <branch>` when it names a track branch;
6. ancestry: the track whose integration (or base) branch the branch is fewest
   commits ahead of, then fewest behind.

A tie, a detached HEAD or unfetched track branches fall back to the workspace
default (the track whose integration branch or PR target is
`vcs.defaultTargetBranch`) with a `note:`; pass `--track` to decide.

The resolved track sets the base of new branches (`baseBranch`), the
`--kind`/`--slug` branch name (`naming`), the default PR target and stack
trunk (`pullRequestTarget`), and, after `workit pr merge` lands on a
`productionBranch`, the `mergeBackBranches` it reports (Workit does not open
merge-back PRs itself). Every track's long-lived branches are protected in
addition to `branchPolicy.protected`, and its naming templates are allowed
branch patterns. `workit grant show` and `workit doctor` list the tracks and
the one the current checkout resolves to. Without `releaseTracks`, nothing
changes.

At runtime a malformed or unknown track field is reported (`workit doctor`
warns) and ignored; a track without a usable `productionBranch` and
`integrationBranch` is skipped. A track that lists a field in its `critical`
array makes Workit fail closed when that field is unknown or malformed.

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
