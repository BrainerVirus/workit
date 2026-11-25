# Configuration and storage

## Setup and upgrades

`workit init` is an interactive wizard with a short basic path and optional
advanced setup (workspace hosting and issue tracking, branch and commit
policies, profiles, release tracks). Detected hosts are preselected; it uses
native package/plugin commands, shows changes before applying them, and never
installs host applications or reloads running sessions. Project setup (hygiene
files, gitignore entries) defaults to No.

```bash
workit upgrade                  # show the plan, ask once, apply, verify
workit upgrade --yes            # the same without the question (scripts, CI)
workit upgrade --preview        # read-only: ends with "preview only; nothing changed"
workit upgrade --hosts=none --cli --yes   # only the global npm CLI
workit launch <host> --auto-upgrade -- <host args>   # upgrade before starting a host
workit upgrade --check          # installed vs latest per component; changes nothing
workit upgrade --set-updates=auto   # prompt (default) | auto | off
```

A CLI older than 8.38.0 has no `--yes` and fails with `unknown option --yes`.
Update it once with `npx -y @workit-dev/cli@latest upgrade --cli --hosts=none --yes` (or, on the old
CLI, `workit upgrade --cli --hosts=none --apply --confirm`), then run
`workit upgrade`.

Planning checks every host at once (registry versions and host inventories,
each probe bounded by its own timeout), so it takes about as long as the slowest
host; a host whose probe does not answer is listed as could not check. Codex's
inventory lists only the plugins of the marketplaces configured on the machine
(`codex plugin marketplace list --json`, then `codex plugin list --json
--marketplace <name>` for each, skipping Codex's remote catalog marketplaces),
because an unscoped `codex plugin list` also fetches OpenAI's remote catalog and
can take 30 s or more; a Codex without those options falls back to the unscoped
list. On a
terminal, upgrade shows a spinner on stderr with the current step (`Checking N
hosts`, each host, the doctor check) and leaves one
`✓`, `✗` or `–` line per step. It stays silent with `--json`, `CI=true`, and
when stderr is not a terminal; `NO_COLOR` or `TERM=dumb` print the finished
step lines without animation. `workit ci wait` and `ci rerun`, a queued
`workit check`, `doctor`, `pr create` and `pr merge`, `stack land` and
`restack`, `release start` and `finish`, `verify-delivery`, `fanout status` and
`check`, `gc` and the `youtrack` steps show the same spinner while they wait.

Human output is colored on a terminal: `workit doctor` status words and a
closing list of what needs attention, the `workit upgrade` plan and result,
the `workit setup` permission diff (`+` green, `-` red), and `workit: error:`
lines in red. Color follows the same rules as the spinner: it is off with
`--json`, `CI=true`, `NO_COLOR` set, `TERM=dumb`, or when the output is not a
terminal, so pipes, CI logs and agent hosts read plain text. `FORCE_COLOR=1`
turns it on for a pipe (never under `--json`). The spinner uses 24-bit color
when `COLORTERM` is `truecolor` or `24bit`, else the 256-color palette when
`TERM` names it, else plain cyan.

One run covers the global CLI (a managed npm global install; links and npx are
left alone), the Claude Code plugin (`claude plugin marketplace update` and
`claude plugin update`), Codex (and its agent files), Pi, Cursor, OpenCode
(`opencode plugin update @workit-dev/opencode`, on an OpenCode that
has it; V2 loads it live), and the permission blocks `workit setup` already
wrote. A registered Cursor whose plugin files are missing is reinstalled with
the same installer `workit init` uses, without touching workspaces or other
config.

On a color terminal the run reads as three screens: the plan and its
question, then one live line (`[2/5] Updating opencode`) that replaces itself
as each step finishes, then only the result table. The plan clears once you
answer, and a step's line stays only when it failed. Every host row shows
installed and target versions; OpenCode and Claude Code, which resolve their
own update, are "already current" when their installed version is the
published one.

The CLI updates first. When it updated, `workit upgrade` continues on the new
version: it starts the new CLI with the same flags, limited to the hosts, so the
host steps run with the release you just installed. The table and the exit code
cover both. If the CLI install fails, the hosts still upgrade with the current
CLI and its row says so.

Each host upgrades on its own: one failing host never stops the others. The run
ends with a table (updated, already current, skipped, failed, each with its
reason and the native command that fixes it) and exits 1 if any host failed.
It then runs doctor's version, asset, agent, stale-install and permission
checks and prints "clean" or what is left. The OpenCode row compares the plugin
version before and after the update with the published one: it is "already
current" only when it already matched before the update. OpenCode V2 loads the
update into its running service, so upgrade waits (up to 20 s) until OpenCode
lists the new version; it names `opencode serve` to restart only if it never does.

Running hosts: zombie processes and helpers that load no plugin are ignored.
The Codex app-server daemon keeps running: it checks the installed plugin
version on each lookup, so its new threads load the update. An open interactive
session is never killed: that host is skipped with its pid and command line.

`--hosts=opencode,cursor,codex,pi,claude-code` limits the hosts (and leaves the
CLI out unless `--cli`). `--apply --confirm` still works as the scripted alias
of `--yes` and prints JSON (as does `--json`). Backups go to
`~/.local/state/workit/upgrades/`. Local checkout sources and exact version
pins are left alone. A registry outage starts `launch --auto-upgrade` on the
unchanged install with a warning.

### Update check on launch

Workit keeps itself current the way the Codex CLI does. When you start any
`workit` command in your own terminal and a newer CLI release is known, it
asks once on stderr:

```text
Workit update available: 8.41.1 -> 8.42.0  [u]pgrade now / [s]kip for now / [n]ever for this version:
```

`u` runs the full upgrade (`workit upgrade --yes`: the CLI and every host
plugin together, never one without the other), prints its per-host table, then
runs the command you typed with the new binary (only if the CLI package was
replaced; a failed host is named with its fix). Everything the check prints
goes to stderr. Ctrl-C or Ctrl-D at the question prints `Cancelled.`, exits
130 and runs nothing. `s` (or Enter) asks again on the
first launch after 24 hours. `n` stays silent for that version and asks again
when a newer one is published.

The `updates` setting in `~/.config/workit/config.json` picks the behavior; set
it with `workit upgrade --set-updates=<mode>`:

| `updates` | On an interactive launch with a newer release |
| --- | --- |
| `prompt` (default) | Ask as above |
| `auto` | Say it is upgrading, run the full upgrade, then your command. A failed upgrade prints the per-host table and still runs your command with the old version |
| `off` | Nothing; upgrade by hand with `workit upgrade` |

The command never waits on the network. The latest version is cached in Workit
state (`~/.local/state/workit/update-check.json`) for 24 hours; a stale cache is
refreshed by a detached background process that prints nothing, and an offline
or failing registry is silent. A cached latest older than the running CLI (you
upgraded since the last lookup) is dropped and refreshed on the next launch,
whatever its age, and never reads as an update. The check runs only on an interactive human
launch: stdin, stdout and stderr are terminals (any redirection skips it), `CI` is unset, there is no `--json`,
and the shell is not an agent host's (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
or any `CODEX_*`, `OPENCODE*`, `CURSOR_*` or `PI_*` variable except
`CODEX_HOME` and `PI_CODING_AGENT_DIR`). Hooks and the MCP server never have a
terminal, so they never check. Every other launch, and `workit upgrade`, `help` and `--version`
themselves, behaves exactly as before.

`workit upgrade --check` asks the registry for the CLI and each installed host
package (all at once, behind one spinner on a terminal; OpenCode's installed
version comes from OpenCode itself), prints installed and latest versions per
component with the command to apply, shows the `updates` setting, and changes
nothing (exit 0; `--json` gives the same data). `workit doctor` shows the setting and the cached latest
version with its age in its `updates` row, read from local files only.

## Config files

`workit config show` prints the effective configuration for the current
checkout, read-only: the matched workspace, the vcs provider and default target
branch, the model per role and the heavy-check resources, each with where it
comes from (a key in `workspaces.json`, `vcs.json` or `.workit/checks.json`,
the origin remote, a release track, the branch preset, Workit's built-in role
defaults, or `default`). `--json` gives the same as
`{ value, source }` pairs. `workit grant show` names the `vcs.provider` and its
source too.

Global config lives in `~/.config/workit/` (`%APPDATA%\workit\` on Windows;
`config.json`, `workspaces.json` and its `workspaces.json.seal`, `vcs.json`,
optional `youtrack.json`, `rules/` and `templates/`). When the host withholds
that dir (permission denied), Workit reads it as no grants and no role models,
which can only lower what an agent may do. Logs, the recorded hook Node, leases and upgrade backups live in
the state dir, `~/.local/state/workit/` on Linux and macOS
(`%LOCALAPPDATA%\workit\` on Windows), and so do the worktrees Workit manages
(`worktrees/<repo>/<slice>`; see [cleanup](cleanup.md)); `$XDG_CONFIG_HOME`, `$XDG_STATE_HOME`,
`WORKIT_CONFIG` (or `WORKIT_CONFIG_DIR`) and `WORKIT_STATE_DIR` move them. macOS kept state in
`~/Library/Application Support/workit` in older versions: the first `workit` run or
hook run moves it, leaves a `workit.moved-<time>` note beside the old place,
and `workit doctor` (row `legacy_dirs`) prints the command that finishes a move
it could not make. Every location and override:
[file locations](../agents/file-locations.md). Workspaces map path
globs to hosting (GitHub/GitLab), trackers, branch/commit policy and
[grants](grants.md); the narrowest glob wins.

Each file has a JSON Schema, generated from the schemas Workit validates with
and shipped in `@workit-dev/core` under `schemas/`. With the first key
`"$schema": "https://unpkg.com/@workit-dev/core/schemas/workspaces.json"`
(or `config.json`, `vcs.json`, `youtrack.json`), VS Code and other editors
complete keys and allowed values (`changelog`: `off | update | create`), show
each field's description on hover and underline an unknown key or a bad value.
`workit setup`, `workit init` and `workit workspace set` write it at the top of
the files they create or rewrite and keep a value you set yourself.
`workit doctor`'s `config_schema` row checks the files against the same
schemas and names the file and JSON path of each bad value
(`workspaces[0].changelog`). It warns rather than fails: Workit still reads a
value it does not know as the default and says so, so a file written for a
newer Workit keeps working in an older one. A key an older Workit wrote and
nothing reads any more is named obsolete, with the removal as the fix: the
global `timezone` in `config.json` (the setup wizard wrote it through 2.1.2; a
work item's day comes from `youtrack.json`'s `timezone`, else `TZ`).

Besides `updates`, `config.json` holds `locale` (the language of Workit's
prompts and drafts, e.g. `en` or `es-419`), `localeOptions` (the locales the
setup wizard offers) and the global `branchPolicy`/`commitPolicy`. `vcs.json`
holds the fallback `provider` (`github` or `gitlab`) and
`defaultTargetBranch`, `github`/`gitlab` blocks whose `host` names a
self-hosted forge (the editor schema also lists `apiUrl` and `tokenFile`
there, but Workit reads neither: the token file is the workspace's
`vcs.tokenFile` in `workspaces.json`), and `pr` defaults (`squashOnMerge`,
`removeSourceBranch`, `pushBranch`, `confirmSkip`).

`workit init` edits the entries you open and leaves every other entry
byte-for-byte as it was. To add or adjust one entry without the wizard:

```bash
workit workspace list                                  # entries, and the one that applies here and why
workit workspace add kit --glob '/home/you/work/libs/kit/**' --from work
workit workspace set kit branchPolicy.integration=merge  # dotted keys, JSON values, null removes
workit workspace rm kit                                # remove an entry; a possible raise needs your terminal
```

`--from` copies the parent's `vcs`, `issues`, `branchPolicy`,
`commitPolicy`, `trailers`, `youtrack` and `models`, never its grants,
`defaultEndpoint` or `verification`. `list`, `add` and `set` never raise
authority, so an agent may run them when you ask: a new entry starts at the
strictest level of every workspace and the defaults, so no folder it takes over
gets more than it had; `set` refuses the grant keys, `name`, `glob`, unknown
keys and, on an entry with grants, `vcs`. `rm` hands the entry's folders to
whichever entry or default matches them next, and a glob's text cannot say
which (symlinks, linked worktrees), so every other entry and the defaults count
as a possible taker. When any of them could grant more (or an equally specific
entry could take a folder that was ambiguous), `rm` is a raise: refused in an
agent or headless shell and confirmed with a y/N in your own terminal (one
answer for several names). A removal that raises nothing proceeds anywhere and prints what now
covers the removed glob. `rm` never removes the last entry. Raise a grant
with `workit grant set` in your own terminal. Each write keeps the previous file as `workspaces.json.bak`, and
`workit doctor` lists overlapping globs and which entry wins.

`workspaces.json.seal`, beside it in the account's config dir, holds the
authority fields you last accepted with `workit workspace seal` in your own
terminal (grants, `defaultEndpoint`, `verification`, `youtrack.writes`,
`youtrack.autoHosts`, `name`, `glob`, entry order, `remotes`,
`externalRepos` and the forge identity). While it is missing or does not match, Workit applies the stricter
of the file and the last seal: [the seal](grants.md#the-seal) has the full
rules.

An agent session never writes `workspaces.json` itself. On every host, the
write gate denies an edit or a shell write (redirect, `tee`, `cp`, `mv`,
`sed -i`…) to it, or a copy, move or removal of the config dir itself. That
covers the dir `WORKIT_CONFIG`, `WORKIT_CONFIG_DIR` or `XDG_CONFIG_HOME` points
at and the default dir grants are read from, reached through `~`, a symlink or
`..` too. The deny names the `workit grant set` or `workit workspace set`
command for you to run in your own terminal. Reading the file,
`workit grant show`, `workit workspace list` and writes to the dir's other
files are unaffected. `workit setup` and `workit upgrade` also write the
host's own deny rules for `workspaces.json`, its seal and Workit's approval
and issued-session stores on Claude Code, Cursor and OpenCode, so they hold
even when a hook cannot load; Codex has no path deny and Pi no permission
layer, so the hook is the only guard there. `workit uninstall` removes them
and `workit doctor` checks them (`native_deny`;
[hosts guide](hosts.md#host-permissions-workit-setup)).

`remotes` lists the remote URLs a workspace owns: a checkout anywhere whose
remote it claims never exceeds its grants ([grants](grants.md#remotes)). Like
a grant, only you change it: `workit workspace set <name> remotes=<url>,…`
needs your terminal and a y/N, and `add` at your terminal offers the
folder's `origin`.

`externalRepos` lists the repositories outside the workspace's own forge
owners that `workit issue create|comment|close --repo` may write to
(`owner/name` or `owner/*`; [grants](grants.md#external-repositories)). It
too needs your terminal: `workit workspace set <name> externalRepos=<repo>,…`.

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
repository whose history should not name agent sessions) in `workspaces.json`
or with `workit workspace set <name> trailers=false`: `workit git commit` then writes no trailer and records
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

A workspace's `deleteBranch` (default `true`) says whether `workit pr merge`
deletes the PR's head branch, locally and on the remote, after a successful
merge ([when it keeps one](delivery.md)). Turn it off with
`workit workspace set <name> deleteBranch=false`; `pr merge --keep-branch` does
it for one merge. A workspace nested inside another inherits it the way it
inherits `trailers`.

### Branch and commit policy

`branchPolicy.preset` is `gitflow`, `github-flow`, `trunk-based` or `custom`
(required when `branchPolicy` is set). `allowed` lists the branch-name globs a
new branch must match, `protected` the branches nobody commits or pushes to
directly, `integration` is `pr` (default) or `merge`, `developBranch` names
gitflow's integration branch (default `develop`) and `prefixes` sets the
`feature`, `bugfix`, `release` and `hotfix` prefixes (all four). A workspace
with its own preset takes that preset's default target branch over
`vcs.json`'s. `commitPolicy.preset` is `conventional`, `gitmoji`,
`ticket-prefix`, `freeform`, `custom` or `auto`, and `pattern` is a regular
expression every subject must match. `config.json` may hold a global
`branchPolicy` and `commitPolicy`; a workspace's own wins.

`profiles` names variants of one workspace's policies, each with a
`branchPolicy`, a `commitPolicy` or both; `defaultProfile` (a key of
`profiles`) applies when none is named, and `WORKIT_PROFILE=<name>` picks one
for a session. An unknown profile name is an error.

### Cleanup when work finishes

A workspace's `cleanup` (default `"auto"`) says what happens when work
finishes. With `auto`, after `workit pr merge` or `workit verify-delivery merge`
sees the merge land and the remote branch go, Workit stops the processes
registered in the branch's worktree, removes that worktree when it is clean
and Workit made it, moves a clean checkout you ran the command in to the
trunk, and deletes the local branch ([what it keeps](cleanup.md#after-a-merge)).
With `"keep"`, nothing is removed or stopped, the merge output says
`kept: workspace cleanup keep`, and the registered processes in the workspace
also outlive session-end stops and the orphan reap (`workit stop <id>` still
stops one). A workspace nested inside another inherits it the way it inherits
`trailers`. A value Workit does not know reads as `keep`, so a typo removes
nothing, and the merge output names the bad value.

```json
{ "name": "demos", "glob": "/home/you/demos/**", "cleanup": "keep" }
```

To keep one branch, worktree or process instead of a whole workspace, record
the user's keep: `workit ledger decision "<what>" --why "<the user's words>"
--keep branch:<name>|worktree:<path>|proc:<id>`
([Keeping things](cleanup.md#keeping-things)).

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
  "youtrack": { "baseUrl": "https://you.youtrack.cloud", "writes": "ask" }
}
```

- `youtrack.writes` (default `ask`, in every workspace that does not set it):
  each `workit youtrack note|time|meeting|update|create` and each YouTrack PR
  backlink waits for your yes: one click on your host's prompt on that call
  (Claude Code, Pi), else `workit approve` in a terminal
  ([Approvals](approvals.md), [YouTrack](youtrack.md#writes-ask-you-first)). `auto` posts
  without asking and needs `WORKIT_YT_WRITE=1` instead; set it yourself, in
  your own terminal.
- `youtrack.autoHosts` (with `writes: "auto"`): the only YouTrack hosts a
  write posts to unasked, `["sandbox.youtrack.cloud"]`; a write to any other
  host asks as with `ask`, and a raw `ytrack` write must name an allowed host
  with `--host` ([YouTrack](youtrack.md#writes-ask-you-first)). Without it,
  `auto` covers every instance a write reaches, and `workit doctor` warns.
  A writer outside your terminal may only remove hosts; adding one needs
  `workit workspace seal`.

- `provider`: `github`, `gitlab` or `youtrack`. A bare `--issue 42` (and a
  number from the branch) is an issue on this tracker when it is `github` or
  `gitlab`, else on the PR's forge.
- `repo` and `host`: where a GitHub or GitLab tracker keeps its issues when
  that is not the PR's own repository (`"repo": "group/project"`; `host`
  defaults to the PR's host on the same forge, else `github.com` or
  `gitlab.com`). An issue tracker on the other forge needs `repo`.
- `link` (default `false`): with no `--issue`, derive the issue from the branch
  name (`feature/42-login` is `#42`, `feature/IRPT-740-x` is `IRPT-740`; a
  YouTrack id needs a base URL). Only a number that starts a path segment
  links: digits inside a slug (`docs/retro-1107-wave1`) never do. A named issue
  always links.
- `relation` (default `closes`): `Closes #42` or `Refs #42`; `pr create --refs`
  picks `refs` for one PR. Any other value is reported as a note by
  `pr create` and read as `closes`; it never invalidates the file.
- `backlink` (default `false`): after opening the PR, comment its URL on each
  linked issue, once per PR: a GitHub or GitLab issue on the PR's forge host
  with the workspace's verified credential, a YouTrack issue through its API.
  An issue on another forge host is not commented on; it is reported as
  `skipped` with a note. Your
  host's permission prompt for `workit pr create` is what allows the comment.
  A YouTrack backlink follows `youtrack.writes`: with `ask` (the default) the
  PR opens and the backlink is reported `pending` with a request to approve;
  after your yes the next `workit pr create` or `workit pr edit` posts it
  once. With `auto` it posts behind `WORKIT_YT_WRITE=1`. A failed comment is reported and never undoes the PR.

An issue on another forge than the PR's cannot be closed from it, so it gets a
`Related to: <issue URL>` line instead of `Closes`.

```json
{ "vcs": { "provider": "github" }, "issues": { "provider": "gitlab", "repo": "group/project", "link": true } }
```

Older keys keep working and are read as aliases: `youtrack.link_issues: true`
is `{ "provider": "youtrack", "link": true }`, and `issues.link_on_pr` is
`link`. A workspace with only `youtrack.baseUrl` links YouTrack issues you
name but derives none from the branch. The YouTrack base URL is the
workspace's `youtrack.baseUrl`, else `baseUrl` in `youtrack.json`: an old
`link_issues` workspace without its own `baseUrl` links through
`youtrack.json`. See [delivery](delivery.md#linking-issues) for `--issue`.

### Delegation

A workspace's `delegation` is `inline-first` (the default) or
`lead-orchestrates`. Under `inline-first` the lead does the work itself, and
`workit fanout plan` refuses a slice without a `reason` (`explore`,
`parallel`, `backstop` or `high-risk-verify`, rendered as the brief's
`REASON:` line). `lead-orchestrates` allows slices without one. An unknown
value reads as the default.

```json
{ "name": "work", "glob": "/home/you/work/**", "delegation": "lead-orchestrates" }
```

### Fanout worktree dependencies

A workspace's `fanout.deps` says how `workit fanout worktree create` gives a
slice worktree its `node_modules`: `"install"` (the default) runs the frozen
install of the worktree's own lockfile, `"link"` links the main checkout's
installed packages instead, for a repo whose install is too slow to run per
slice. `fanout.installTimeout` (a duration such as `"90s"` or `"10m"`, default
`"5m"`) bounds that install: past it, the install's whole process tree is
killed and the worktree is linked instead. `--deps` and `--install-timeout`
on one create override them. A workspace nested inside another inherits each
the way it inherits `trailers`. The create output adds a note when a
workspace value applied, and names a value Workit does not read, which is
ignored (the default applies). `--install-timeout` with `fanout.deps` `"link"`
needs `--deps install` too. See
[delivery](delivery.md#parallel-slices-fanout) for what each choice does.

```json
{ "name": "monorepo", "glob": "/home/you/big/**", "fanout": { "deps": "link" } }
```

### Changelog and docs steps

A workspace can add a Keep a Changelog step and a docs refresh to shipping.
Both are off by default.

- `changelog`: `off` (default), `update` or `create`. When it is on, the ship
  skill passes the PR's entry under `## [Unreleased]` as
  `workit pr create … --changelog "<Section>: <entry>"`, which commits and
  pushes it, and `pr create` refuses a user-facing PR whose branch adds no
  bullet there (`changelog_required`, whose `Retry as:` adds that flag). `update` asks for an entry only where CHANGELOG.md already exists
  and says in one line when there is none; `create` asks for it always
  (`workit changelog apply` creates the file). See
  [delivery](delivery.md#changelog-gate).
- `changelogPath`: where the changelog lives, repo-relative (default
  `CHANGELOG.md` at the root). A JSON list names more than one; an entry in
  any of them satisfies the gate. A glob (`projects/*/CHANGELOG.md`, `*` and
  `?` within one directory, `**` across them) makes each tracked file it
  matches the changelog of its directory: every such package the diff touches
  needs its own entry, and a diff touching none of them needs one in any.
  Without it, a repo
  whose only changelog sits elsewhere is told the exact
  `workit workspace set <ws> changelogPath=<file>` to run, and the
  by-hand `workit changelog apply` command the gate prints carries `--path <file>`.
- `docs`: `off` (default) or `when-user-facing`. When it is on, the ship skill
  updates only the README and guide lines the diff made false, names public
  surfaces no doc covers in the PR body, and reports a pass that changed
  nothing. `pr create` checks it without blocking: a doc file in the diff, or
  a `Docs` line in the PR body.

```bash
workit workspace set work changelog=create docs=when-user-facing
workit workspace set work changelogPath=docs/CHANGELOG.md
workit workspace set work 'changelogPath=["packages/a/CHANGELOG.md","packages/b/CHANGELOG.md"]'
workit workspace set work 'changelogPath=["projects/*/CHANGELOG.md"]'
workit workspace set work changelog=null   # back to off
```

Any other value is refused with the allowed list, and a `changelogPath` that
is absolute or climbs out with `..` is refused. `workit grant show` prints the
steps and the changelog file, and `workit init`'s advanced workspace settings
offer the two steps (the path is set with `workit workspace set`). An unknown
value hand-written in `workspaces.json` reads as off, with a note.

### PR description template

`prTemplate` picks the template a PR description fills. `workit pr template`
prints it and the file it came from. `workit pr create` refuses a body that
leaves a chosen template unfilled: the repo's own, or Workit's when
`prTemplate` is `workit` ([delivery](delivery.md#pr-description-template)).

- `auto` (default): the repo's GitHub or GitLab template, checked by
  `pr create`. A repo without one is not checked: `pr create` works as before
  and `workit pr template` prints Workit's (Summary, Evidence, Merge danger) as
  a suggestion. Workit looks in
  `.gitlab/merge_request_templates/Default.md`,
  `.github/pull_request_template.md` (either case), its
  `.github/PULL_REQUEST_TEMPLATE/` and `docs/` variants and the repo root; a
  template directory with exactly one `.md` file counts, one with several needs
  a path.
- `repo`: the repo's template only; without one, `pr template` and
  `pr create` refuse (`pr_template_missing`) and name the paths searched.
- `workit`: Workit's template, checked by `pr create`, even when the repo has
  its own.
- A repo-relative `.md` path, e.g. `.gitlab/merge_request_templates/Feature.md`,
  to pick one of several.

```bash
workit workspace set work prTemplate=workit
workit workspace set work prTemplate=.gitlab/merge_request_templates/Feature.md
workit workspace set work prTemplate=null   # back to auto
```

Another word, an absolute path or one that climbs out with `..` is refused.
`workit grant show` prints the setting and the file it picks, and
`workit init`'s advanced workspace settings offer auto, repo and workit. An
unknown value hand-written in `workspaces.json` reads as auto, with a note.

### Release notes

`releaseNotes` decides what `workit release finish` publishes on the GitHub
or GitLab release ([delivery](delivery.md#release-notes)). Outside git-flow it
decides the release PR's body and the forge release that
`workit git push --release <tag>` creates after the merge. A release track
can set its own (`releaseTracks.<track>.releaseNotes`), which wins over the
workspace's for that track.

- `auto` (default): the draft from `workit release notes draft <version>`
  when there is one, else the notes built from the version's changelog
  section.
- `off`: no forge release; the finish still merges, tags and pushes, and says
  why. Outside git-flow the release PR body stays the changelog section.
  Under every other mode `workit git push --release <tag>` creates the forge
  release too.
- `review`: `finish` refuses (`release_notes_unapproved`) before any merge,
  tag or push until the user approves the current draft with
  `workit release notes approve <version>` in their own terminal. Outside
  git-flow, `finish` will not open the release PR and
  `workit git push --release <tag>` will not push until then. An edit to the
  draft after the approval needs a new one.

```bash
workit workspace set work releaseNotes=review
workit workspace set work releaseTracks.nun.releaseNotes=off
workit workspace set work releaseNotes=null   # back to auto
```

Another word is refused. `workit grant show` prints the mode and each track
that overrides it, and `workit init`'s advanced workspace settings offer auto,
off and review. An unknown value hand-written in `workspaces.json` reads as
auto, with a note.

### Models per role

Subagents inherit the lead's model unless the spawn names one, so a lead on a
large model runs every verifier and implementer on it too. `models.roles` names
the model (and, where the host takes one, the effort) each role runs on, per
host. Put it at the top of `workspaces.json` for a global default
(`workit workspace set --global models.roles.verifier.claude_code=sonnet`),
and on a workspace to override it (`workit workspace set <name> models.…`); a nested workspace inherits each role it leaves unset
from the enclosing one, then from the global default.

Roles: `decider`, `implementer` (one entry per fanout tier: `mundane`,
`standard`, `hard`), `verifier`, `reviewer`, `explore` (read-only scouting),
`babysit` (PR and CI watching) and `default` (a general spawn: Claude Code's
`general-purpose`, OpenCode's `general`; a `ROLE: <role>` line in the spawn
prompt picks another role). A role is an object keyed by host
(`claude_code`, `opencode`, `codex`, `codex_cli`, `codex_desktop`, `cursor`,
`pi`, plus an optional `default`; `codex_cli` and `codex_desktop` win over
`codex` for that app) whose values are a model name or `{ "model": "...", "effort": "..." }`.
A bare model name or `{ model, effort }` applies to every host. Effort values
are the host's own (Claude Code: `low`, `medium`, `high`, `xhigh`, `max`; Pi
`--thinking` levels; Codex `model_reasoning_effort`).

```json
{
  "models": {
    "roles": {
      "verifier": { "claude_code": "sonnet", "codex": { "model": "gpt-5.1-codex-mini", "effort": "low" } }
    }
  },
  "workspaces": [
    {
      "name": "personal",
      "glob": "/home/you/projects/personal/**",
      "models": {
        "roles": {
          "implementer": { "hard": { "claude_code": { "model": "opus", "effort": "high" } } },
          "reviewer": { "claude_code": "opus" }
        }
      }
    }
  ]
}
```

**Defaults.** Each Workit role is a host agent that carries its own model,
so a lead spawns it by name and passes no model. With nothing configured,
Claude Code's plugin agents run on: `workit:decider` `fable` (effort `high`),
`workit:implementer` and `workit:verifier` `sonnet`, `workit:reviewer`
`opus`, `workit:babysitter` `haiku`. A slice's tier adds `opus` (hard) or
`haiku` (mundane) through its brief's `SPAWN:` line. `Explore` keeps Claude
Code's own model. The other hosts have no built-in defaults: a role with no
entry runs on the host's own model. `workit models show [--role r] [--tier t]
[--host h] [--json]` prints what each role resolves to, where it came from
(default host: the lead's, else `claude_code`), how it reaches a spawn per
host (`agent file`, `spawn fill` or `advisory`) and the `models.enforce`
mode. `workit doctor` and `workit grant show` report an unknown role, tier or
host key, or a value that is not a model or effort name; those entries are
skipped.

**The lead's model, a named model and `models.enforce`.** `models.lead` (same
shape as a role) names the model the lead session should run on per host. No
host lets Workit set a session's own model, so it is advisory: `workit models
show` lists it for you to pick with the host's model switch. A model the lead
(or the user) names on a spawn always wins, and no spawn is denied over its
model or effort: `models.enforce` is `"advise"` by default. Set it to
`"strict"` to hold every spawn to a configured role model: a named model then
loses to it unless `"allowLeadOverride": true`, and Claude Code's auto mode
denies a spawn that lacks it, with the exact Agent args to retry.

```json
{ "models": { "lead": { "claude_code": "opus" }, "enforce": "advise", "roles": { "default": { "claude_code": "sonnet" } } } }
```

**How each host applies it.**

- Claude Code: the plugin agents' `model:` and `effort:` frontmatter carry
  the defaults above. A role configured to another value (or `Explore` and
  `general-purpose`, which have no Workit agent file) is filled on a spawn
  that names no model: outside auto mode the PreToolUse hook sets it through
  `updatedInput` with a note naming what to pass next time. Auto mode refuses
  a call a hook rewrote, so there the spawn runs as written and the lead gets
  one line naming the model that ran and the configured one, with the args to
  pass. A spawn that names a model is never changed. A full Claude id
  (`claude-sonnet-5-5`) is applied as its family alias; a value the Agent tool
  cannot take is skipped with a note. The session contract says to spawn
  roles by name and lists only the roles configured to differ from their
  agent file. `workit models show --report [--days n]` lists the models
  subagents actually ran on (default last 7 days) and flags a role that ran on
  a non-default one. A user-level `~/.claude/agents/` file cannot replace a
  plugin agent (plugin agents are namespaced), so a per-workspace value rides
  the spawn.
- OpenCode: the plugin registers `workit-implementer`, `workit-verifier`,
  `workit-reviewer`, `workit-decider` and `workit-babysitter` as subagents,
  each on its `models.roles` model for the project (`providerID/modelID`,
  optionally `#variant`; none: the parent's), re-read when `workspaces.json`
  changes. The judges and the decider cannot edit. A `subagent` call that
  names a model keeps it; one that names none gets an implementer tier's,
  `general`'s or explore's role model, or a usage-limit fallback. A continued
  child keeps its model. Effort is not set.
- Codex: when the plugin copies its `workit-*` agents (implementer, verifier,
  reviewer, decider, babysitter) into `$CODEX_HOME/agents/`, a configured
  role's file gets `model` and `model_reasoning_effort`. A value in the file
  overrides what a spawn passes, so the implementer file gets one only when
  all three tiers resolve to the same model. Restart Codex after a change.
- Cursor: the plugin ships `workit-verifier`, `workit-reviewer`,
  `workit-decider` and `workit-babysitter` agents with no model, so the
  parent's model runs unless the spawn names one; a configured role is
  advisory: pass it as the Task tool's `model`.
- Pi: a supervised worker gets `--model` and `--thinking` for a configured
  role (reviewer; investigator uses `explore`; implementer only when its tiers
  agree). Without config the worker keeps the ambient model.

**Migrating `fanout.tierModels`.** It keeps working: it is read as
`models.roles.implementer.<tier>` (a model name per tier and host, no
effort). Within one workspace `models.roles` wins when both name a tier.
Move a tier by renaming `fanout.tierModels.hard` to
`models.roles.implementer.hard`.

`workit fanout brief` adds the `model:` line under `TIER:` (and `effort:`),
plus the `SPAWN:` lines for a Claude Code lead. Its VERIFY section also gets a
`checks:` line that names each configured check a verdict records
(`workit check <name>`) and that the slice's VERIFY does not already run.
`workit fanout status` names the model next to each slice it lists to
spawn (`spawnModels` in `--json`). The lead's host comes from its environment
(`WORKIT_HOST` or the host's own session variable).

### Usage-limit fallback

A role's value may be an ordered list of models instead of one. The first model
whose provider is not exhausted runs. When a subscription hits its usage limit,
Workit marks that provider exhausted for this user until the reset named in the
limit text. A limit text with no reset time lasts `models.limitWindow` (a
duration such as `"5h"` or `"1d 12h"`, or a number of hours; default `5h`). The primary model runs
again once the reset passes.

```json
{
  "models": {
    "limitWindow": "5h",
    "roles": {
      "reviewer": { "claude_code": ["opus", "sonnet", "haiku"] },
      "verifier": ["sonnet", "haiku", "openai/gpt-5"]
    }
  }
}
```

`models.lead` takes the same list form. No host lets Workit switch a running
session's own model, so a lead whose provider is exhausted gets a one-line
notice naming the next `models.lead` model to switch to. `workit models show`
lists the exhausted providers and their resets.

Per host:

- Claude Code: the Agent hook reads the tails of this project's transcripts
  written in the last 30 minutes for a usage-limit error (5-hour and weekly
  limits, per Opus and Sonnet). Claude Code runs only Anthropic models, so a
  role falls back only to another Claude family on a per-family limit. The
  note on that spawn tells the lead to re-dispatch the dead worker once.
- OpenCode: after each `subagent` call the plugin reads its error (or a short
  result) for a usage limit, marks the provider of the model it ran on and
  tells the lead to re-dispatch that worker; the next spawn of that role gets
  the next model in the list. This is where a list across providers pays off,
  e.g. Anthropic, then OpenAI, then OpenCode Go.
- Codex: the agent files are written at launch, so a fallback applies from the
  next session start. No hook sees a subagent's error, so nothing marks a limit
  on Codex; `workit models show` still names the fallback for a limit another
  host recorded.
- Cursor: advisory. No Cursor hook can change a spawn or see its error, so
  `workit models show` names the model to pass.
- Pi: a supervised worker for a configured role gets the fallback model at
  launch from the shared store. No hook reads a worker's error, so Pi marks no
  limit itself.

### Feedback

`workit feedback` ([reporting Workit friction](feedback.md)) reads one key,
`feedback`, in workspaces.json. At the top level, `{ "account": "<login>" }`
names the GitHub login `--post` uses in every workspace. On a workspace,
`"off"` drops the feedback line from the agent contract and makes the verb
refuse, `"on"` turns it back on inside an `"off"` workspace, and
`{ "account": "<login>" }` overrides the top-level login (a value that is not
a GitHub login reads as unset). Nested workspaces inherit it from the nearest
entry that sets it. `workit workspace set` does not take `feedback` yet: edit
it by hand in your own terminal. With no login configured, `--post` needs `--account`:
the workspace's own forge account is never used by default.

```json
{
  "feedback": { "account": "your-personal-login" },
  "workspaces": [{ "name": "client", "glob": "/home/you/client/**", "feedback": "off" }]
}
```

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
[machine-wide check lease](checks.md#the-heavy-check-lease).

### Heavy-check slots

`resources.slots` in a workspaces.json entry sets how many heavy checks run at
once on this machine. The default is 1: parallel test suites pushed the
desktop session out of memory before the lease existed. Raise it (at most 64) only on a
machine with room for more:

```bash
workit workspace set work resources.slots=2
```

Each heavy check may use up to `resources.memoryMax` (default 40% of RAM).
When `slots` times that is more than the RAM, every check prints a warning
naming a `memoryMax` that fits. A repo's `.workit/checks.json` cannot change
`slots`. `workit lock status` shows the slots, who holds them and each
waiter's estimated wait.

On Linux each heavy check also runs in a systemd scope with `MemoryMax`
(`memoryMax`) and `CPUQuota` (`cpuQuota`); `"scope": false` turns the scope off
and keeps the lease. A repo can only lower `memoryMax` and `cpuQuota`, and
cannot set `scope` ([checks](checks.md#the-heavy-check-lease)).

### Heavy-check budget

Instead of a count of slots, a machine can weigh its heavy checks. These keys
live in the workspaces.json entry only; a repo's `.workit/checks.json` can
only tighten them (a lower `budget`, a larger `reserve`, a heavier weight), and
anything else there is ignored with the machine-only warning. The published
editor schema does not list `budget`, `weights`, `reserve`, `pressure` or
`maxHold` yet, so an editor underlines them and `workit doctor`'s
`config_schema` row names them as unknown keys; Workit still reads them.

```json
"resources": {
  "budget": 3,
  "weights": { "test": 2, "e2e": "6G" },
  "reserve": "6G"
}
```

- **`budget`**: a number is units (each check weighs 1 unless `weights` says
  more, and checks are counted, not charged memory); a size (`"24G"`) or a percent of RAM (`"60%"`) is a memory budget,
  under which as many checks run as their measured memory allows. Without it
  the memory budget is the RAM less the reserve.
- **`weights`**: per check, a whole number of units, or a fixed memory charge
  (`"6G"`) in place of its measured peak RSS.
- **`reserve`**: memory kept for the desktop and IDE. The default is automatic:
  a quarter of the RAM, between 2 GiB and 6 GiB
  ([checks guide](checks.md#waiting-for-the-heavy-check-lease)).
- **`pressure`**: `false` turns the pressure gate off.

A small check whose weight fits what is free runs ahead of a bigger one
waiting (backfill), until the bigger one has waited 5 minutes: from then on
nobody behind it takes what it needs. A dev server registered by the process
registry holds memory only, never a slot or a queue place; a start that does
not fit is refused at once, naming the holders and how to free the room.
`workit lock status` shows the budget and the admitted holders.

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
3. `WORKIT_RELEASE_TRACK=<name>` for a host session (a name this workspace
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

## Release packages

A repository that publishes several packages from one release line (git-flow
`main` + `develop`, one `release/X.Y.Z` branch that bumps the main package
and dates every changelog) tags each package under its own namespace on the
same release commit: bare `4.6.0` for the main package, `pkg-a@0.1.0` and
`pkg-b@0.2.0` beside it (bare main tags: `git config gitflow.prefix.versiontag ""`).
Declare the packages under the workspace's `releasePackages`, keyed by
package name:

```json
{
  "name": "monorepo",
  "glob": "/home/you/work/monorepo/**",
  "branchPolicy": { "preset": "gitflow" },
  "changelogPath": ["projects/*/CHANGELOG.md"],
  "releasePackages": {
    "pkg-a": {},
    "pkg-b": { "tagNamespace": "pkg-b@", "changelogPath": "projects/pkg-b/CHANGELOG.md" }
  }
}
```

- `tagNamespace` (default `<name>@`): the package's tags are
  `<tagNamespace><version>`, without the workspace's release tag prefix
  (`pkg-a@0.1.0`, not `pkg-a@v0.1.0`). It starts with a letter or `@` and
  does not end in a digit.
- `changelogPath` (optional): the package's changelog. Without it, Workit
  uses the `changelogPath` file in a directory named after the package
  (`projects/pkg-a/CHANGELOG.md` for `pkg-a`).

Packages are not release tracks: they have no branches of their own, so
feature branches, PR targets and track resolution behave exactly as without
them. A package tag is a release tag of the workspace's own line, with the
same rules: `workit git push --release pkg-a@0.1.0` pushes it under the
`release` grant only when its commit is already on the production branch, and
a tag never moves. A raw `git push origin pkg-a@0.1.0` is denied with that
command. An unknown field or a bad entry is reported and ignored.

The flow, after `workit release start 4.6.0` and the release commit:

```bash
workit release notes draft 4.6.0             # the main version's notes
workit release finish                        # merge, tag 4.6.0, merge back, push, forge release (Latest)
workit release notes draft pkg-a@0.1.0       # optional: the package's notes, from its changelog
workit release package pkg-a 0.1.0 --dry-run # the plan: tag pkg-a@0.1.0 on the 4.6.0 commit
workit release package pkg-a 0.1.0           # tag, push, forge release (not Latest), verify
workit release package pkg-b 0.2.0
```

`workit release package <name> <version>` tags the commit of the newest
workspace release tag on the remote production branch (the release commit
`finish` just pushed), or `--at <ref>`. It refuses when the tag already
exists locally or on the remote. The push goes through
`workit git push --release` (the `release` and `push` grants), the forge
release follows `releaseNotes` exactly as `finish` does (`review` needs the
approved draft of `pkg-a@0.1.0`, `off` skips it), and the release does not
take GitHub's Latest mark unless you pass `--latest`. GitLab has no Latest
mark, so the flag does nothing there. `workit release notes draft|show|approve`
take the package tag (`pkg-a@0.1.0`) or `--package <name> <version>`, and keep
the package's draft apart from the main version's.

If the push is refused (`--at` names a commit production does not have yet),
the command deletes the local tag it just made, only while the remote lacks
it, so a rerun with the right `--at` is not blocked by `tag_exists`.

Set a package from the CLI with `workit workspace set <workspace>
releasePackages.pkg-a.changelogPath=projects/pkg-a/CHANGELOG.md` (or
`.tagNamespace=<prefix>`; `releasePackages.pkg-a=null` removes it); a value the
reader would ignore is refused. `workit grant show` lists each package's tag
shape and the changelog it resolves to, and `workit doctor` warns
(`release_packages`) on a bad entry or a package whose changelog (its
`changelogPath`, or the one found by directory name) is no file in the
checkout. `workit release package` and `release notes draft <pkg>@<version>`
print a note, without blocking, when the package's changelog has no section
for the version.

With a `changelogPath` list or glob, `workit release notes draft 4.6.0` reads
the `## [4.6.0]` section from every matching changelog and prefers one no
package claims.

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
- In a git checkout, `.workit/` holds only committed team config
  (`checks.json`, `risk-paths`). Older runtime leftovers there (a 2.x marker,
  `tasks/`, `workspace.json`) move once into `.git/workit/legacy/<checkout>/v2/`
  on the first CLI write or read; only exact Workit markers and empty dirs are
  deleted.
- Workit never asks a repository to ignore anything: notes go to
  `workit dir notes` (`.git/workit/notes`, the same from every worktree), a
  fanout worker's scratch to `<state>/scratch/<repo>/<slice>`, so no repo
  needs a Workit entry in `.gitignore`, `.prettierignore` or a tool's
  ignores. `workit doctor` warns when `.workit/` holds untracked files other
  than team config; `workit doctor --fix` moves each into `workit dir notes`
  at the same relative path, never overwriting (a taken name gets a numbered
  one) and never touching tracked files or team config.
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

## Heavy-check queue

Queue order, stuck holders, exit codes, `workit lock status` and every
`resources` field with its default and what a repo may change are in
[the heavy-check lease](checks.md#the-heavy-check-lease); the weighted
budget's keys are under [heavy-check budget](#heavy-check-budget) above.
