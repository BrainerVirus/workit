# Workit

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@workit-dev/cli.svg?label=workit-cli)](https://www.npmjs.com/package/@workit-dev/cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Workflow rails for agentic coding.** The agent decides *what* to do; the
`workit` CLI does the *how* (branch, commit, push, PR, CI, stack, merge) and
records *proof* of what it observed. You stay in the loop for product
judgment, not for checking whether the tests really ran or the push really
landed.

One shared core ships as native integrations for **Claude Code, OpenCode,
Cursor, Codex CLI/desktop and Pi**, plus a standalone CLI.

- **Observed, not claimed.** `workit check` runs your real test command and
  records the exit code, HEAD and tree. An agent saying "tests pass" is a note,
  not evidence.
- **Author ≠ verifier.** Verdicts are recorded per session in a SHA-keyed
  ledger; the session that wrote the code can never verify it.
- **Bounded autonomy.** Per-workspace grants decide how far an agent may go
  (push, PR, merge) without asking. Your host's permission prompts still win.
- **No bookkeeping.** Every branch is its own implicit task. Agents never
  manage ids.

## Contents

- [Quickstart](#quickstart)
- [Core concepts](#core-concepts)
- [Daily workflow](#daily-workflow)
- [Skills](#skills)
- [CLI reference](#cli-reference)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)

## Quickstart

Requires **Node.js 24+**. Claude Code, Codex and Cursor hooks start the `node`
on your `PATH`; in a repo pinned to an older Node they find a Node 24+ on their
own (`WORKIT_NODE`, the Node `workit setup` recorded, then fnm, nvm, volta, mise
and asdf installs). `workit doctor` (row `hook_node`) shows which Node they use;
with none, install Node 24 or run `workit setup` from a Node 24 shell. The
setup wizard detects your hosts, installs the ones you pick with their native
commands, and writes your global config:

```bash
npx @workit-dev/cli init
workit doctor          # after the CLI install below
workit setup           # optional: let agents run Workit's delivery verbs without a prompt
```

`workit setup` shows the exact diff, asks once (`--yes` for a script,
`--dry-run` to only look) and writes a Workit-owned block into each host's own
permission config: enumerated `workit git|pr|ci|stack|release|task|ledger|…`
verbs only, never `workit check -- …`, `workit lock run -- …` or `workit
grant`. Run it in your own terminal, not from an agent session (it refuses
there). `workit uninstall` removes exactly what it added, and `workit doctor`
reports drift. Per-host details are in
[the hosts guide](docs/guides/hosts.md#host-permissions-workit-setup).

Or install a single host by hand. Whatever the install path, every host
updates with `workit upgrade` and uninstalls with `workit uninstall` (pick the
host); the native commands below are the fallback.

To install or repair Workit on some hosts without the wizard, name them:
`workit install --hosts=cursor --preview` prints the exact files, config keys,
host commands and notes and changes nothing; `--yes` installs them. A healthy
host plans nothing, so a second run changes nothing; a host whose CLI is not on
PATH shows a blocked row. It never touches another host or `~/.config/workit`.

To remove Workit from some hosts without the picker, name them:
`workit uninstall --hosts=cursor --preview` prints the exact files, config keys
and host commands it would remove and changes nothing; `--yes` removes them.
Other hosts, your own rules and `~/.config/workit` stay as they are.

`workit setup`, `workit install` and `workit uninstall` are yours to run, in
your own terminal: the CLI refuses `--yes` from an agent session and hands you
the command, and the host asks about or denies an agent's call.

Coming from `@brainervirus/workit-*` (14.x)? The packages moved to
`@workit-dev/*` and restarted at 1.0.0: run
`npx -y @brainervirus/workit-cli@latest upgrade` once, and see
[the migration guide](docs/guides/migration.md#100-the-packages-move-to-workit-dev).

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude plugin marketplace add BrainerVirus/workit
claude plugin install workit@workit
```

Update: `workit upgrade` (fallback: `claude plugin marketplace update workit &&
claude plugin update workit@workit`; Claude Code does not auto-update plugins by
default). Restart Claude Code afterwards: it loads plugins once per process.
Uninstall: `workit uninstall`, or `claude plugin uninstall workit@workit`.

Pin to a local checkout instead (sources run with Bun, edits apply without a
rebuild; disable the marketplace copy with `claude plugin disable workit@workit`):

```bash
bun install
bun packages/workit-claude-code/scripts/build.ts --skills-only
claude --plugin-dir "$PWD/packages/workit-claude-code"
```

Skills appear as `/workit:<name>`, plus `verifier`, `reviewer`,
`implementer`, `decider` and `babysitter` agents, each on its own model. See
[the Claude Code guide](docs/guides/claude-code.md).

</details>

<details>
<summary><strong>OpenCode</strong> (2.0.18+)</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@workit-dev/opencode"]
}
```

Update: `workit upgrade` (fallback:
`opencode plugin update @workit-dev/opencode`; other plugins stay as
they are). OpenCode 2.x loads the new version live, with no restart. Use the
`plugins` key; `workit setup --hosts=opencode` moves an entry out of the
deprecated `plugin` key. Uninstall: `workit uninstall`, or remove the entry
from `plugins`.

Local pin: build once with `bun packages/workit-opencode/scripts/build.ts`, then
use `"plugins": ["file:///path/to/workit/packages/workit-opencode"]`.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `npx @workit-dev/cli init` and select Cursor: it installs the
plugin (MCP server, session hook, contract rule, skills). Update:
`workit upgrade` (fallback: `workit upgrade --hosts=cursor`), which also
reinstalls missing plugin files. Uninstall: `workit uninstall`. Manual MCP
setup is in [the hosts guide](docs/guides/hosts.md#cursor).

</details>

<details>
<summary><strong>Codex CLI / desktop</strong></summary>

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workit
```

Update: `workit upgrade`, which updates the plugin and refreshes the Codex agent
files; the app-server daemon keeps running and its new threads load the update (fallback:
`codex plugin marketplace upgrade workit && codex plugin add
workit@workit`, then a new Codex session). Uninstall:
`workit uninstall`.
Skills are invoked as `$workit-<name>` or from the `/skills` picker.

</details>

<details>
<summary><strong>Pi</strong> (1.4.0+)</summary>

```bash
pi install npm:@workit-dev/pi
pi install ./packages/workit-pi -l --approve   # local checkout
```

Update: `workit upgrade` (fallback: `pi update --extension
npm:@workit-dev/pi`). Uninstall: `workit uninstall`.

</details>

<details>
<summary><strong>CLI only</strong></summary>

```bash
npx -y @workit-dev/cli@latest upgrade --cli --hosts=none --yes
workit help
```

This installs the CLI into `~/.local/share/workit/versions/<v>` with a
`~/.local/bin/workit` launcher (Windows: `%LOCALAPPDATA%\workit\install`),
independent of which Node version manager a shell uses. `workit upgrade`
moves an older `npm i -g` copy over and `workit doctor` lists every copy on
your machine ([install guide](docs/guides/install.md)).

Every verb works without a host; hosts just put `workit` and the skills in
front of the agent. Update with `workit upgrade --hosts=none --cli`; remove it with
`workit uninstall` (pick the CLI). It removes the `~/.local/bin/workit` link
only when it points into the install; in `bin/`, only the launcher Workit wrote
and its temp files; it unlinks `current`; and from `versions/`, only entries
holding the Workit CLI package. Anything else (a file of your own, a link
elsewhere, an install root set to your home) is left untouched and named.

</details>

## Core concepts

**Implicit task per branch.** The first note, check, ledger record or commit
on a branch creates its task; every task command without an id applies to it.
State lives in the git common directory (`.git/workit/`, shared by all
worktrees) as an append-only event log. `workit task status` shows it;
`workit handoff` prints a resume brief.

**Observed evidence (`workit check`).** `workit check test` runs the configured
command (from `.workit/checks.json`, else detected defaults such as
`<pm> run test`, `go test ./...`, `cargo test`, `pytest`) and records exit
code, HEAD and tree. Gates accept only a fresh passing run of a configured
check; a check is stale once the worktree changes. Ad-hoc
`workit check -- <cmd>` runs are recorded but never satisfy a gate.

**Ledger verdicts (author ≠ verifier).** `workit ledger verdict` records a
result (`verified`, `tests-verified`, `type-check-only`, `blocked`, `failed`)
for a branch head under the acting session. A verdict from the session that
authored the commits is never accepted. Verdicts carry across rebases when
the patch-id and diff are unchanged, and across docs-only follow-up pushes;
one verdict at the top of a stack covers its unchanged lower PRs
([carry-over](docs/guides/verification.md#carry-over-and-stack-verdicts)).
`workit ledger check` answers "is this head independently verified?".

**Autonomy grants.** Per-workspace grants in `~/.config/workit/workspaces.json`
set the ceiling: `push`, `pr` and `rerun` are allowed by default; `merge` needs
`true` or `verified`, and merges only with the verdict the PR's review lane
asks for. `defaultEndpoint` is where an unnamed delivery request stops:
`commit` (default), `pr`, `green` (babysit CI and threads until merge-ready,
never merging) or `merged`; `workit grant show` reports the effective one.
Raising a grant or the endpoint needs you at a terminal; agents can only lower
them. The authority fields are sealed: `workit workspace seal`, in your own
terminal, accepts a change, and until then nothing above the last seal applies
(`workit doctor` warns, `grant_seal`). See [grants](docs/guides/grants.md).
`workit workspace list|add|set` adds or adjusts one entry without the wizard
and never raises a grant
([configuration](docs/guides/configuration.md#config-files)).

**Policy.** Judge tracked work in four calls (`workit policy assess --judge
risk=trivial|normal|high behavior=yes|no product-choice=yes|no plan=yes|no`,
or the flat `workit_policy` tool fields) and Workit derives what it needs:
nothing for trivial work, an observed `workit check test` and the verdict the
change's review lane asks for, an independent live verdict and a plan for high
risk. Under the default `verification: "proportional"` the lane comes from the
diff: `none` (docs, comments, formatting, generated copies) needs no verdict,
`self` (a small change off risk paths) the author's own `--self` verdict,
`focused` and `full` (risk paths such as hooks, auth, release, migrations or
the repo's own `.workit/risk-paths`, a lockfile, or a large diff) a non-author
verdict, at task close, the Stop hook and the merge gate alike; when unsure, a
file counts as a behavior change. `workit pr status` and `workit policy
assess` show it. An open product choice or a needed plan blocks code
edits until recorded, on every host with a pre-write hook (advisory on Codex).
See [verification](docs/guides/verification.md). Host permissions
(allow/ask/deny, sandbox) always stay authoritative; Workit adds no consent
prompts of its own.

**Release tracks.** A repository with several release lines (say
`nun-develop` -> `nun-master` and `develop` -> `master`) lists them under the
workspace's `releaseTracks`; branch bases, PR targets, merge-back hints and
protected branches then follow the line each branch belongs to. See
[release tracks](docs/guides/configuration.md#release-tracks).

**Stacks.** `workit stack` manages plain base-branch PR chains on GitHub and
GitLab (no Graphite or `gh stack` needed): plan, restack after a merge, and
land the stack all or nothing: every PR is checked before any merges
(`--max N` lands just the first N). See
[delivery and stacks](docs/guides/delivery.md).

## Daily workflow

```text
shape  →  implement  →  review  →  ship
 │          │             │          └─ push, PR, CI green, land when granted
 │          │             └─ non-author verdict in the ledger
 │          └─ small steps, `workit check`, prove it on the running app
 └─ brainstorm, grill open choices, slice into PRs
```

1. **Shape** (`/wk-shape`, `/workit:shape`): agree what to build and how to
   slice it. A spec or ADR is proposed only when it pays off.
2. **Implement**: build in small steps; run `workit check <name>`; commit with
   `workit git commit`.
3. **Review**: a different session (the `verifier`/`reviewer` agent, or a
   reviewer started with its own `WORKIT_SESSION_ID`) records
   `workit ledger verdict`.
4. **Ship**: `workit git push`, `workit pr create --issue <#n|ID>` (links the
   issue on GitHub, GitLab or [YouTrack](docs/guides/youtrack.md)), `workit ci wait`,
   `workit pr status`; `workit pr merge` only when the PR is READY, verified and
   the `merge` grant allows it, and then deletes the merged head branch
   (`--keep-branch` to opt out). `workit verify-delivery` confirms it landed.
   The PR body fills the repo's template, else Workit's (`workit pr template`);
   a workspace can require a changelog entry per user-facing PR
   (`workit pr create … --changelog "<Section>: <entry>"`). See
   [delivery](docs/guides/delivery.md) and its
   [changelog gate](docs/guides/delivery.md#changelog-gate).

For independent slices, **fanout** runs one worker per isolated worktree with
a fixed brief and file-scope manifest, and a non-author verifier per slice:
`workit fanout plan` refuses incomplete briefs and overlapping scopes,
`workit fanout worktree create <slice>…` makes each worker's worktree and
prints its `WORKTREE:` line and exact spawn, `workit fanout brief` renders the
brief with the lead's standing orders, `workit fanout status` flags stuck
workers and suggests a landing order, and `workit fanout check` gates fan-in.
See [parallel slices](docs/guides/delivery.md#parallel-slices-fanout).

## Skills

Skills load automatically when the task fits, or explicitly: `/wk-<name>`
(OpenCode, Cursor, Pi), `/workit:<name>` (Claude Code), `$workit-<name>`
(Codex).

| Skill | Use it to |
| --- | --- |
| `shape` | Brainstorm, grill open choices, challenge premises, slice into PRs, propose a spec/ADR when it pays |
| `implement` | Build a change in small verified steps and hand verification to a non-author |
| `review` | Review a diff/branch/PR (intent, standards, test quality, blast radius) as a non-author verdict |
| `debug` | Find the root cause from a deterministic repro before patching |
| `ship` | Open or stack PRs, fix red CI, answer threads, land verified PRs when granted |
| `continue` | Checkpoint, hand off, and resume across sessions by re-verifying inherited claims |
| `bdd` | Turn requirements into Given/When/Then and work test-first in RED/GREEN slices |
| `test-audit` | Find tautological or low-value tests and replace them with ones that catch breaks |
| `deslop` | Remove dead code, restating comments and filler before a PR, behavior unchanged; depth follows the review lane |
| `fanout` | Run independent slices in parallel worktrees with per-slice verifiers |
| `verify-app` | Generate the project's own `verify-<app>` skill that drives the real app |
| `retro` | User-invoked: find repeated friction in recent sessions and propose cited fixes ranked by enforcer strength; never applies them |
| `architecture` | User-invoked: rank cited deepening opportunities from churn and ledger friction, grill the chosen one into slices; also restructures AGENTS.md in reviewable passes and sweeps tests; never refactors without approval |

## CLI reference

`workit help <command> [<subcommand>]`, or `-h`/`--help` anywhere after a
command (before a bare `--`), prints its usage, flags and examples and runs
nothing. A bare `--` ends any command's options: after it `-h` is an ordinary
value, and a command that takes no positional arguments refuses anything there
(exit 2) before it runs. A value that starts with `-`
goes as `--flag=value` (`workit git commit --message=-h`); `-h` right after a
flag that takes a value is refused as ambiguous. A `--flag` a command does not
take fails with exit 2 and an `unblock` naming the closest valid flag (or the
right form: `workit status` points at `workit task status`, `pr create --head`
at switching branches). Alternate spellings work: `--fanout` and `--name` both
select a fanout plan, `ledger verdict --sha <sha>` is `--head <sha>` (the sha
must be the head being judged), and `task list --status all` lists every task.
Global flags:
`--json` (envelope `{"ok","code","data","error"?,"unblock"?}`), `--cwd <dir>`,
`--session <id>` (act as that session; beats `WORKIT_SESSION_ID`), `--version`. Exit codes: `0` ok, `1` failed, `2` usage, `3` blocked,
`4` busy/pending, `5` unavailable.

In a color terminal, help prints bold headings, commands and flags in cyan
and dim summaries; `NO_COLOR`, `--json`, a pipe or `TERM=dumb` give the plain
text.

| Command | Purpose |
| --- | --- |
| `workit init` | Interactive setup wizard (hosts, config, optional project files) |
| `workit setup [--hosts=…] [--dry-run \| --yes]` | Write Workit's host permission block after showing the diff |
| `workit doctor [--json] [--fix] [--fix-lock]` | Offline installation health; repair what it can; clear a stale store lock |
| `workit upgrade [--preview \| --yes] [--hosts=…] [--cli]` | Upgrade the CLI and every host after one confirmation, then verify with doctor |
| `workit upgrade --check` / `--set-updates=prompt\|auto\|off` | Compare installed and latest versions; choose how a launch handles a new release |
| `workit launch <host> --auto-upgrade` | Upgrade, then start a host |
| `workit completion zsh\|bash\|fish\|powershell` | Print the shell completion script (setup and upgrade install it for `$SHELL`) |
| `workit dir [plans\|retros\|handoffs\|notes\|config\|state\|…]` | Print where a kind of file lives (plans, retros, handoffs and notes per clone; config, state, data, cache and runtime per user) |
| `workit gc [--dry-run]` | Compact task logs, drop unreferenced blobs and old check logs; `--worktrees`, `--branches` and `--procs` list (`--apply` removes or stops) what finished work left |
| `workit install --hosts=<h,…> [--preview\|--yes]` | Install or repair Workit on the named hosts only; a healthy host changes nothing |
| `workit uninstall [--hosts=<h,…> [--preview\|--yes]]` | Pick hosts (and the owned CLI install), or name them, and remove what Workit put there (keeps `~/.config/workit`) |
| `workit grant show\|set\|unset` | Workspace autonomy grants and `defaultEndpoint` |
| `workit approve <id>…` | Ask you to approve a Workit request (a YouTrack write, release notes under review) on a host with no prompt on the action; your yes is recorded once ([approvals](docs/guides/approvals.md)) |
| `workit config show` | The effective config here (workspace, VCS provider, target branch, role models, heavy-check resources), each value with its source |
| `workit workspace list\|add\|set\|rm\|seal` | List, add, edit or remove workspace entries without the wizard (never raises a grant); `seal` accepts the authority fields at your terminal |
| `workit models show` | The model and effort each role (decider, implementer tiers, verifier, reviewer, babysit) runs on for a host, how it reaches a spawn there (`agent file`, `spawn fill` or `advisory`) and the `models.enforce` mode |
| `workit task status\|start\|note\|close\|adopt` | The current branch's task |
| `workit handoff` | Resume brief: branch, HEAD, dirty state, verdict, next command |
| `workit check <name>` | Run a configured check and record observed evidence |
| `workit lock status\|reap\|cancel\|wait\|run\|heavy` | The machine-wide heavy-check lease: holders and waiters, freeing a stuck holder's slot, dropping queued checks, waiting, running a command under it, heavy patterns |
| `workit run --bg [--port <n>] [--name <n>] -- <cmd…>` | Start a dev server or `docker compose up` under the process registry: one server per repo, charged to the heavy budget ([background processes](docs/guides/processes.md)) |
| `workit ps [--all]` | The registered background processes: id, pid, port, RSS, owner session |
| `workit stop <id>… \| --session <s> \| --within <dir> \| --orphans` | Stop registered processes (process group, SIGTERM then SIGKILL; docker rows stop only their containers), with a ledger row each |
| `workit test-audit [--diff] [--mutate]` | Flag tautological tests; optional diff-scoped mutation |
| `workit deslop scan\|result` | Class the comments, suppressions and debug leftovers a branch adds, by review lane, with no agent; record one result line per PR ([review depth](docs/guides/review.md)) |
| `workit knowledge lint` | Lint AGENTS.md budget, local links, scaffold-only and duplicated rules; register as `workit check knowledge` |
| `workit ledger decision\|ruling\|verdict\|standing\|list\|check\|verify-integrity\|finding\|void\|add` | Decisions, rulings, SHA-keyed verdicts, a fanout's standing orders and the hash chain; `finding` runs `workit finding`; `void` (yours, at a terminal) voids a verdict that is wrong on its face |
| `workit git branch\|commit\|stage\|unstage\|push\|rebase\|hold\|trailers` | Policy-checked branch (`--carry` moves uncommitted work onto it) and commit; hunk staging; leased push with verified remote tip; rebase onto the trunk; `hold` records your "not yet" so the Stop hook stops asking to push |
| `workit pr status\|create\|template\|ready\|edit\|threads\|reply\|merge` | PR state and next action; SHA-bound create; the body template; review threads; gated merge |
| `workit issue view\|comment\|close\|create` | Read, comment on, close or open an issue on the workspace's GitHub or GitLab tracker (writes need the `pr` grant) |
| `workit ci wait\|rerun\|logs` | Wait for CI on the PR head; rerun failed jobs once per head; print the failing jobs' log tails |
| `workit stack plan\|status\|sync\|restack\|land` | Base-branch PR stacks: plan, restack after a parent merged, land root first |
| `workit fanout plan\|brief\|check\|status\|worktree` | Register parallel slices (complete briefs, disjoint scopes); render each worker's brief with the standing orders; watch them (STUCK, PR, CI, verdict, landed); create and release slice worktrees; gate fan-in on scope, merge conflicts and landing order |
| `workit verify-delivery push\|pr\|merge\|release` | Confirm on the remote that it landed (bare, it infers which; exit 1 when not) |
| `workit release start\|finish\|publish\|notes\|package\|tag` | git-flow releases without the git-flow binary: cut, finish (merge, tag, merge back, forge release with user-facing notes) and publish per release track; `notes draft\|show\|approve` drafts the release notes, and under `releaseNotes: review` only the user approves them ([release notes](docs/guides/delivery.md#release-notes)); `package <name> <version>` tags, pushes and releases a monorepo package (`pkg-a@0.1.0`) on the same release commit, not Latest ([release packages](docs/guides/configuration.md#release-packages)); `tag v<version>` releases a tag-driven repository (GoReleaser and similar): it tags the green remote trunk and pushes the tag, and `notes edit <tag> --from-changelog` backfills a published release's notes ([tag-driven releases](docs/guides/release.md)) |
| `workit youtrack note\|time\|meeting\|update\|show\|create` | Read and create YouTrack issues; comments, attachments, work time and state, one yes per write unless `writes: auto` covers the host ([YouTrack guide](docs/guides/youtrack.md)) |
| `workit feedback "<title>" --body-file <f\|->` | Draft a redacted report of Workit friction for the Workit tracker, with version, host, verb and exit text; suggests a duplicate, saves the draft under `workit dir retros`, and posts only with `--post` after your yes ([reporting friction](docs/guides/feedback.md)) |
| `workit changelog apply\|merge\|driver` | Add entries under the changelog's Unreleased section; `driver install` registers the merge driver (`merge`) that keeps both sides' entries |
| `workit <family> <action>` | Low-level task families: `task`, `policy`, `evidence`, `finding`, `decision`, `worker`, `state` |

### Shell completion

`workit setup` and `workit upgrade` install tab completion for the shell in
`$SHELL`: verbs, subcommands and flags, plus configured check names
(`workit check <Tab>`), fanout slice ids (`workit fanout worktree create <Tab>`)
and workspace names. The values come from `workit __complete`, which reads only
local files. No rc file is edited:

| Shell | Installed to |
| --- | --- |
| zsh | `$XDG_DATA_HOME/zsh/site-functions/_workit` (`~/.local/share/zsh/site-functions/_workit`) |
| bash | `$XDG_DATA_HOME/bash-completion/completions/workit` (loaded by bash-completion) |
| fish | `$XDG_CONFIG_HOME/fish/completions/workit.fish` |
| PowerShell | nothing; add `workit completion powershell \| Out-String \| Invoke-Expression` to `$PROFILE` |

zsh loads `_workit` only from a directory on its `$fpath`. When that directory
is missing from it, setup prints the lines to add to `~/.zshrc`, before any
other `compinit`:

```zsh
fpath=("$HOME/.local/share/zsh/site-functions" $fpath)
autoload -Uz compinit && compinit
```

`workit completion <shell>` prints the script for any other setup
(`source <(workit completion zsh)`). Only a file Workit wrote is replaced.

## Upgrading

Upgrade every host together: newer store records are refused by older
runtimes. `workit upgrade` shows a per-host plan, asks once (`--yes` skips the
question, `--preview` changes nothing), applies with a backup, and ends with a
per-host table and doctor's verdict. Running hosts, the Codex daemon, backups
and `--hosts`: [setup and upgrades](docs/guides/configuration.md#setup-and-upgrades).

Workit also checks for a new release when you start any `workit` command in
your own terminal (never in CI, a pipe, `--json` or an agent host). It asks
`[u]pgrade now / [s]kip for now / [n]ever for this version`; upgrading always
updates the CLI and every host plugin together, then reruns your command. Set
`updates` to `auto` to upgrade without asking or `off` to never check, with
`workit upgrade --set-updates=<mode>`; `workit upgrade --check` shows installed
vs latest and changes nothing. The check reads a 24 h cache refreshed in the
background, so no command waits on the network:
[update check on launch](docs/guides/configuration.md#update-check-on-launch).

| From | Key breaks |
| --- | --- |
| 2.x → 3.0 | OpenCode V1 adapter removed (OpenCode 2.0.18+); `workit cutover` removed |
| 3.x → 4.0 | Task state moves to `.git/workit/` event store, implicit task per branch; old `.workit/` migrates on first CLI use (backup kept) |
| 4.x → 5.0 | Skill set v3: 16 skills merged into 11; old `wk-*` aliases removed; `ledger verdict --as` never makes the author independent |
| 5.x → 6.0 | Approval receipts, `autoApprove`, managed external actions and the writer/checkout lease are gone; authority is host permissions plus autonomy grants |

Details and the skill rename table: [migration guide](docs/guides/migration.md).

## Troubleshooting

Run `workit doctor` (or `--json`) first: each row names its check id and its
repair. The table maps common symptoms to those ids.

| Symptom | Doctor check | Fix |
| --- | --- | --- |
| Something is off after install or upgrade | `versions`, `stale_install`, `stale_pin` | `workit upgrade`; each finding names its repair |
| Hook says `workit migration pending` | none | Run `workit task status` once in that checkout; hooks never migrate |
| A command returns `busy` (exit 4) | `workspace_lock` | Another workit process holds the store or stack lock; retry. A dead holder is reclaimed automatically; `workit doctor --fix-lock` clears a stale one. For the heavy-check lease, `workit lock status` names the holder |
| `blocked` (exit 3) on push/PR/merge | `grant_endpoint`, `grant_seal`, `github_identity`, `gitlab_identity` | Read `unblock` in the output: usually a missing grant (`workit grant show`), an unsealed change (`workit workspace seal` in your own terminal) or a `gh`/`glab` login that is not the workspace account |
| Agents get permission prompts for `workit` verbs | `claude_permissions`, `codex_permissions`, `cursor_permissions`, `*_grant_rules` | `workit setup` in your own terminal |
| Hook answers `workit context skipped: host under load` | `hook_deadline` | Rare under normal load; see the [Claude Code guide](docs/guides/claude-code.md) for `WORKIT_HOOK_DEADLINE_MS` |
| Store grows large | none | `workit gc --dry-run`, then `workit gc` |
| `recovery` copies from 2.x reported | none | `workit gc --prune-recovery --yes` |
| Claude Code hook prints `[workit] Claude Code hook unavailable` | `claude_plugin`, `claude_session_plugin` | The hook failed open: install Bun for a local pin, or `workit upgrade` and restart Claude Code |
| Codex hooks do not run | `codex_hooks` | Trust them with `/hooks` in Codex |
| Codex verifier or reviewer agents missing | `codex_agents` | `workit upgrade`, then a new Codex session |
| OpenCode fails `opencode_version` | `opencode_version` | Upgrade OpenCode to 2.0.18+ |
| Pi does not load Workit | `pi_extension` | See [Pi](docs/guides/hosts.md#pi) |
| An agent could edit a Workit-guarded file (`workspaces.json` and its seal, approvals, issued sessions) | `native_deny` | `workit setup` in your own terminal writes each host's own deny rules (Claude Code, Cursor, OpenCode) |
| `youtrack.writes: auto` posts to any YouTrack | `youtrack_writes` | Name the allowed hosts in `youtrack.autoHosts` ([YouTrack guide](docs/guides/youtrack.md)) |
| Agents do not know ytrack's commands | `ytrack_skill` | The fix doctor names: `ytrack skill install`, `ytrack skill sync` or `ytrack upgrade` (ytrack 0.6.0+ keeps its own skill) |

More: [configuration and storage](docs/guides/configuration.md).

## Documentation

- Setup: [Install](docs/guides/install.md) ·
  [Claude Code](docs/guides/claude-code.md) ·
  [Other hosts](docs/guides/hosts.md) ·
  [Configuration](docs/guides/configuration.md) ·
  [Grants](docs/guides/grants.md) ·
  [Approvals](docs/guides/approvals.md) ·
  [Migration](docs/guides/migration.md) ·
  [Troubleshooting](docs/guides/troubleshooting.md)
- Daily work: [Verification](docs/guides/verification.md) ·
  [Checks](docs/guides/checks.md) ·
  [Review depth](docs/guides/review.md) ·
  [Delivery and stacks](docs/guides/delivery.md) ·
  [Changelog](docs/guides/changelog.md) ·
  [Tag-driven releases](docs/guides/release.md) ·
  [Background processes](docs/guides/processes.md) ·
  [Cleanup](docs/guides/cleanup.md) ·
  [YouTrack](docs/guides/youtrack.md) ·
  [Reporting friction](docs/guides/feedback.md)
- Design record: [`docs/workit-next/`](docs/workit-next/spec.md)
- Release qualification: [`docs/qualification/`](docs/qualification/qualification.md)
- History: [`docs/archive/`](docs/archive/README.md) · [CHANGELOG](CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent and maintainer conventions for
this repository live in [AGENTS.md](AGENTS.md), [`docs/agents/`](docs/agents/) and [CODING_STANDARDS.md](CODING_STANDARDS.md).

## License

[MIT](LICENSE)
