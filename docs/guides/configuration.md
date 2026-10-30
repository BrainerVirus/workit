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
Update it once with `npm i -g @brainervirus/workit-cli@latest` (or, on the old
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
(`opencode plugin update @brainervirus/workit-opencode`, on an OpenCode that
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
or failing registry is silent. The check runs only on an interactive human
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

Global config lives in `~/.config/workit/` (`config.json`, `workspaces.json`,
`vcs.json`, optional `youtrack.json` and `templates/`). Workspaces map path
globs to hosting (GitHub/GitLab), trackers, branch/commit policy and
[grants](grants.md); the narrowest glob wins.

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
agent or headless shell and confirmed by typing the workspace name in your own
terminal. A removal that raises nothing proceeds anywhere and prints what now
covers the removed glob. `rm` never removes the last entry. Raise a grant
with `workit grant set` in your own terminal. Each write keeps the previous file as `workspaces.json.bak`, and
`workit doctor` lists overlapping globs and which entry wins.

`remotes` lists the remote URLs a workspace owns: a checkout anywhere whose
remote it claims never exceeds its grants ([grants](grants.md#remotes)). Like
a grant, only you change it: `workit workspace set <name> remotes=<url>,…`
needs your terminal and the workspace name typed, and `add` at your terminal
offers the folder's `origin`.

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

- `provider`: `github`, `gitlab` or `youtrack`. A bare `--issue 42` (and a
  number from the branch) is an issue on this tracker when it is `github` or
  `gitlab`, else on the PR's forge.
- `repo` and `host`: where a GitHub or GitLab tracker keeps its issues when
  that is not the PR's own repository (`"repo": "group/project"`; `host`
  defaults to the PR's host on the same forge, else `github.com` or
  `gitlab.com`). An issue tracker on the other forge needs `repo`.
- `link` (default `false`): with no `--issue`, derive the issue from the branch
  name (`feature/42-login` is `#42`, `feature/IRPT-740-x` is `IRPT-740`; a
  YouTrack id needs a base URL). A named issue always links.
- `relation` (default `closes`): `Closes #42` or `Refs #42`; `pr create --refs`
  picks `refs` for one PR. Any other value is reported as a note by
  `pr create` and read as `closes`; it never invalidates the file.
- `backlink` (default `false`): after opening the PR, comment its URL on each
  linked issue, once per PR: a GitHub or GitLab issue on the PR's forge host
  with the workspace's verified credential, a YouTrack issue through its API.
  An issue on another forge host is not commented on; it is reported as
  `skipped` with a note. Your
  host's permission prompt for `workit pr create` is what allows the comment,
  as with `workit youtrack note`, and a YouTrack comment also needs
  `WORKFLOW_YT_WRITE=1` in the environment, the same gate as `workit
  youtrack note`. A failed comment is reported and never undoes the PR.

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

### Changelog and docs steps

A workspace can add a Keep a Changelog step and a docs refresh to shipping.
Both are off by default.

- `changelog`: `off` (default), `update` or `create`. When it is on, the ship
  skill writes the PR's entry under `## [Unreleased]` with
  `workit changelog apply`, as the last step before `workit pr create`, and
  `pr create` refuses a user-facing PR whose branch adds no bullet there
  (`changelog_required`, with the `workit changelog apply --entries …` command
  to run). `update` asks for an entry only where CHANGELOG.md already exists
  and says in one line when there is none; `create` asks for it always
  (`workit changelog apply` creates the file). See
  [delivery](delivery.md#changelog-gate).
- `changelogPath`: where the changelog lives, repo-relative (default
  `CHANGELOG.md` at the root). A JSON list names one changelog per package in
  a monorepo; an entry in any of them satisfies the gate. Without it, a repo
  whose only changelog sits elsewhere is told the exact
  `workit workspace set <ws> changelogPath=<file>` to run, and the
  `workit changelog apply` command the gate prints carries `--path <file>`.
- `docs`: `off` (default) or `when-user-facing`. When it is on, the ship skill
  updates only the README and guide lines the diff made false, names public
  surfaces no doc covers in the PR body, and reports a pass that changed
  nothing.

```bash
workit workspace set work changelog=create docs=when-user-facing
workit workspace set work changelogPath=docs/CHANGELOG.md
workit workspace set work 'changelogPath=["packages/a/CHANGELOG.md","packages/b/CHANGELOG.md"]'
workit workspace set work changelog=null   # back to off
```

Any other value is refused with the allowed list, and a `changelogPath` that
is absolute or climbs out with `..` is refused. `workit grant show` prints the
steps and the changelog file, and `workit init`'s advanced workspace settings
offer the two steps (the path is set with `workit workspace set`). An unknown
value hand-written in `workspaces.json` reads as off, with a note.

### Models per role

Subagents inherit the lead's model unless the spawn names one, so a lead on a
large model runs every verifier and implementer on it too. `models.roles` names
the model (and, where the host takes one, the effort) each role runs on, per
host. Put it at the top of `workspaces.json` for a global default, and on a
workspace to override it; a nested workspace inherits each role it leaves unset
from the enclosing one, then from the global default.

Roles: `decider`, `implementer` (one entry per fanout tier: `mundane`,
`standard`, `hard`), `verifier`, `reviewer`, `explore` (read-only scouting) and
`babysit` (PR and CI watching). A role is an object keyed by host
(`claude_code`, `opencode`, `codex`, `cursor`, `pi`, plus an optional
`default`) whose values are a model name or `{ "model": "...", "effort": "..." }`.
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

**Defaults.** With nothing configured, Claude Code gets decider `fable`
(effort `high`), implementer `hard` `opus`, `standard` `sonnet`, `mundane`
`haiku`, verifier `sonnet`, reviewer `opus`, explore `haiku` and babysit
`haiku`. The other hosts have no built-in defaults: a role with no entry runs
on the host's own model. `workit models show [--role r] [--tier t] [--host h]
[--json]` prints what each role resolves to and where it came from (default
host: the lead's, else `claude_code`). `workit doctor` and `workit grant show`
report an unknown role, tier or host key, or a value that is not a model or
effort name; those entries are skipped.

**How each host applies it.**

- Claude Code: a subagent spawn that names no `model` gets its role's model
  (and `effort`) from the plugin's PreToolUse hook, so `Explore` runs on the
  explore role and `workit:verifier` on the verifier role; a spawn that names a
  model keeps it, and a spawn is never denied over its model.
  `workit models show --report [--days n]` lists the models subagents actually
  ran on (default last 7 days) and flags a role that ran on a non-default one.
  The fanout brief also names `model:` and `effort:` under TIER and a
  `verifier:` line; `workit fanout status` names the model per spawnable
  slice; the skills tell the lead to pass the model (and `effort`) from
  `workit models show` on each Agent call. A user-level `~/.claude/agents/`
  file cannot replace the plugin's `workit:verifier`, `workit:reviewer` or
  `workit:implementer`: plugin agents are namespaced and a user agent is a
  different name, so the per-call `model` is the mechanism.
- Codex: when the plugin copies its agents into `$CODEX_HOME/agents/`, a
  configured role's file gets `model` and `model_reasoning_effort`. A value in
  the file overrides what a spawn passes, so the implementer file gets one
  only when all three tiers resolve to the same model. Restart Codex after a
  change.
- Pi: a supervised worker gets `--model` and `--thinking` for a configured
  role (reviewer; investigator uses `explore`; implementer only when its tiers
  agree). Without config the worker keeps the ambient model.
- OpenCode and Cursor: Workit registers no agents of its own there, so the
  skills and the brief name the model and the lead passes it (Cursor's Task
  `model`; an OpenCode subagent takes its model from its agent config).

**Migrating `fanout.tierModels`.** It keeps working: it is read as
`models.roles.implementer.<tier>` (a model name per tier and host, no
effort). Within one workspace `models.roles` wins when both name a tier.
Move a tier by renaming `fanout.tierModels.hard` to
`models.roles.implementer.hard`.

`workit fanout brief` adds the `model:` line under `TIER:` (and `effort:`),
and `workit fanout status` names the model next to each slice it lists to
spawn (`spawnModels` in `--json`). The lead's host comes from its environment
(`WORKIT_HOST` or the host's own session variable).

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

## Heavy-check queue

The machine-wide heavy-check lease
([delivery guide](delivery.md#heavy-checks-share-the-machine)) is a queue, not
a door that shuts. A heavy check that finds every slot held takes a ticket and
waits its turn, first come, first served, across every agent and worktree of
the user. It prints where it stands when it starts waiting and every 30 s
after:

```text
workit: waiting for the heavy-check lease (1 slot): held by test, pid 4121, session s-a, 3m 10s, /work/wt/a; queued at position 2, waiting up to 30m (--wait <dur> sets it)
workit: still queued for the heavy-check lease: position 1, 4m 30s of 30m waited; held by test, pid 4121, …
```

```bash
workit check test                 # queues up to resources.wait (default 30 min)
workit check test --wait 45m      # wait longer: 90, 90s, 30m and 1h all work
workit check test --no-wait       # exit 4 at once if the lease is busy
workit lock status                # the holders, then the queue in arrival order
```

- **Exit 4** (`busy`) means `--no-wait` met a busy lease, or the wait really
  ran out. The message names the holders with their age and this check's
  place in the queue.
- **Light checks.** The named checks `lint`, `typecheck` and `format` are
  light: they never take the lease, so they run at once beside a long suite.
  The machine owner sets the list with `resources.light` in
  `workspaces.json`; listing a check under `resources.heavy` there makes it
  heavy again. A repo's `.workit/checks.json` can add heavy checks (that
  removes them from the light list) but cannot mark one light.
- **A waiter that dies gives up its place.** A ticket holds while its
  `workit` process runs; the next waiter removes a ticket whose process is
  gone, by the same test as a stale lease. A shell tool that kills a long
  call (Claude Code and OpenCode stop a foreground call after 2 minutes by
  default) therefore costs the place in line: run a long wait in a
  background call, or with a longer tool timeout.
- **`resources.wait`** takes seconds (`1800`) or a duration (`"30m"`), from
  either config file.

| Field   | Default                       | Where     | Meaning                                     |
| ------- | ----------------------------- | --------- | ------------------------------------------- |
| `light` | `lint`, `typecheck`, `format` | workspace | Named checks that never take the lease      |
| `heavy` | `test`, `build`, `packaging`  | both      | Named checks that queue; a repo only adds   |
| `wait`  | `1800` (30 min)               | both      | How long a queued check waits before exit 4 |
