# Workit

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainervirus/workit-cli.svg?label=workit-cli)](https://www.npmjs.com/package/@brainervirus/workit-cli)
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
- [Contributing](#contributing)

## Quickstart

Requires **Node.js 24+**. Claude Code, Codex and Cursor hooks start the `node`
on your `PATH`; in a repo pinned to an older Node they find a Node 24+ on their
own (`WORKIT_NODE`, the Node `workit setup` recorded, then fnm, nvm, volta, mise
and asdf installs). `workit doctor` (row `hook_node`) shows which Node they use;
with none, install Node 24 or run `workit setup` from a Node 24 shell. The setup wizard detects your hosts, installs the
ones you pick with their native commands, and writes your global config:

```bash
npx @brainervirus/workit-cli init
workit doctor          # after a global install (npm i -g @brainervirus/workit-cli)
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

A CLI older than 8.38.0 has no `--yes` (it fails with `unknown option --yes`).
Update the CLI once with `npm i -g @brainervirus/workit-cli@latest` (or, on the
old CLI, `workit upgrade --cli --hosts=none --apply --confirm`), then run
`workit upgrade`.

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

Skills appear as `/workit:<name>`, plus `verifier`, `reviewer` and
`implementer` agents. See [the Claude Code guide](docs/guides/claude-code.md).

</details>

<details>
<summary><strong>OpenCode</strong> (2.0.18+)</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@brainervirus/workit-opencode"]
}
```

Update: `workit upgrade` (fallback:
`opencode plugin update @brainervirus/workit-opencode`; other plugins stay as
they are). OpenCode 2.x loads the new version live, with no restart. Use the
`plugins` key; `workit setup --hosts=opencode` moves an entry out of the
deprecated `plugin` key. Uninstall: `workit uninstall`, or remove the entry
from `plugins`.

Local pin: build once with `bun packages/workit-opencode/scripts/build.ts`, then
use `"plugins": ["file:///path/to/workit/packages/workit-opencode"]`.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `npx @brainervirus/workit-cli init` and select Cursor: it installs the
plugin (MCP server, session hook, contract rule, skills). Update:
`workit upgrade` (fallback: `workit upgrade --hosts=cursor`), which also
reinstalls missing plugin files. Uninstall: `workit uninstall`. Manual MCP
setup is in [the hosts guide](docs/guides/hosts.md#cursor).

</details>

<details>
<summary><strong>Codex CLI / desktop</strong></summary>

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workflow-toolkit
```

Update: `workit upgrade`, which updates the plugin and refreshes the Codex agent
files; the app-server daemon keeps running and its new threads load the update (fallback:
`codex plugin marketplace upgrade workflow-toolkit && codex plugin add
workit@workflow-toolkit`, then a new Codex session). Uninstall:
`workit uninstall`.
Skills are invoked as `$workit-<name>` or from the `/skills` picker.

</details>

<details>
<summary><strong>Pi</strong> (1.4.0)</summary>

```bash
pi install npm:@brainervirus/workit-pi
pi install ./packages/workit-pi -l --approve   # local checkout
```

Update: `workit upgrade` (fallback: `pi update --extension
npm:@brainervirus/workit-pi`). Uninstall: `workit uninstall`.

</details>

<details>
<summary><strong>CLI only</strong></summary>

```bash
npm i -g @brainervirus/workit-cli
workit help
```

Every verb works without a host; hosts just put `workit` and the skills in
front of the agent. Update with `workit upgrade --hosts=none --cli`; remove
with `npm rm -g @brainervirus/workit-cli`.

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
`true` or `verified`, and both merge only with the verdict the PR's review
lane asks for (an accepted independent one outside `verification:
proportional`; `true` also allows a ledger-recorded `--unverified --reason` bypass);
`defaultEndpoint` is where an unnamed delivery request
stops: `commit` (default), `pr` (push and open the PR), `green` (open the PR,
then babysit CI, review threads and required rebases until it is merge-ready,
never merging) or `merged` (`green`, then `workit pr merge`; it acts as `green`
until the workspace has the merge grant). Without the `push` or `pr` grant any
of them acts as `commit`; `workit grant show` reports the effective endpoint. Raising a grant or the endpoint needs
you at a terminal; agents can only lower them. See
[grants](docs/guides/grants.md). `workit workspace list|add|set` adds or
adjusts one entry without the wizard and never raises a grant
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
land the contiguous verified run from the root. See
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
   issue on GitHub, GitLab or YouTrack), `workit ci wait`,
   `workit pr status`; `workit pr merge` only when the PR is READY, verified and
   the `merge` grant allows it, and then deletes the merged head branch
   (workspace `deleteBranch`, `--keep-branch` to opt out; never a protected,
   fork, stack-parent or foreign-author branch). `workit verify-delivery`
   confirms it landed. A workspace can opt in to a changelog step
   (`workit workspace set <ws> changelog=update|create docs=when-user-facing`,
   default off): ship writes the Unreleased entry with
   `workit changelog apply` before the PR, and `pr create` refuses a
   user-facing PR without one unless given `--no-changelog "<reason>"`
   ([changelog gate](docs/guides/delivery.md#changelog-gate)).
   The PR body fills the repo's GitHub or GitLab template, else Workit's
   Summary, Evidence and Merge danger: `workit pr template` prints it, and
   `pr create` refuses a body that leaves out its headings or keeps its
   `<!-- -->` placeholders (workspace `prTemplate: auto|repo|workit|<path>`,
   [PR template](docs/guides/delivery.md#pr-description-template)).

For independent slices, **fanout** runs one worker per isolated worktree with
a fixed brief and file-scope manifest, and a non-author verifier per slice.
`workit fanout plan` refuses incomplete briefs and overlapping scopes before
any spawn, `workit fanout brief` renders each worker's brief with the lead's
standing orders (`workit ledger standing`; workers already running get each
change on their next tool call, and `standing add --stop` tells them to stop
and report), `workit fanout status` flags
stuck workers and suggests a landing
order, `workit fanout worktree create|release` gives each worker its own
worktree on every host (with `node_modules` linked so its tests import its own
code; Workit's hooks keep an implementer inside it), and `workit fanout check`
gates fan-in. See
[parallel slices](docs/guides/delivery.md#parallel-slices-fanout).

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
| `deslop` | Remove dead code, restating comments and filler before a PR, behavior unchanged |
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
`--version`. Exit codes: `0` ok, `1` failed, `2` usage, `3` blocked,
`4` busy/pending, `5` unavailable.

| Command | Purpose |
| --- | --- |
| `workit init` | Interactive setup wizard (hosts, config, optional project files) |
| `workit setup [--hosts=…] [--dry-run \| --yes]` | Write Workit's host permission block after showing the diff |
| `workit doctor [--json] [--fix] [--fix-lock]` | Offline installation health; repair what it can; clear a stale store lock |
| `workit upgrade [--preview \| --yes] [--hosts=…] [--cli]` | Upgrade the CLI and every host after one confirmation, then verify with doctor |
| `workit upgrade --check` / `--set-updates=prompt\|auto\|off` | Compare installed and latest versions; choose how a launch handles a new release |
| `workit launch <host> --auto-upgrade` | Upgrade, then start a host |
| `workit gc [--dry-run]` | Compact task logs, drop unreferenced blobs and old check logs |
| `workit uninstall` | Pick hosts and remove their registrations (keeps `~/.config/workit`) |
| `workit grant show\|set\|unset` | Workspace autonomy grants and `defaultEndpoint` |
| `workit workspace list\|add\|set` | List, add or edit workspace entries without the wizard; never raises a grant |
| `workit models show` | The model and effort each role (decider, implementer tiers, verifier, reviewer) runs on for a host |
| `workit task status\|start\|note\|close\|adopt` | The current branch's task |
| `workit handoff` | Resume brief: branch, HEAD, dirty state, verdict, next command |
| `workit check <name>` | Run a configured check and record observed evidence |
| `workit lock status\|wait\|run\|heavy` | The machine-wide heavy-check lease: holders, waiting, running a command under it, heavy patterns |
| `workit test-audit [--diff] [--mutate]` | Flag tautological tests; optional diff-scoped mutation |
| `workit knowledge lint` | Lint AGENTS.md budget, local links, scaffold-only and duplicated rules; register as `workit check knowledge` |
| `workit ledger decision\|ruling\|verdict\|standing\|list\|check\|verify-integrity` | Decisions, rulings, SHA-keyed verdicts, a fanout's standing orders and the hash chain |
| `workit git branch\|commit\|push\|trailers` | Policy-checked branch/commit; leased push with verified remote tip |
| `workit pr status\|create\|ready\|edit\|threads\|reply\|merge` | PR state and next action; SHA-bound create; review threads; gated merge |
| `workit ci wait\|rerun\|logs` | Wait for CI on the PR head; rerun failed jobs once per head; print the failing jobs' log tails |
| `workit stack plan\|status\|sync\|land` | Base-branch PR stacks |
| `workit fanout plan\|brief\|check\|status\|worktree` | Register parallel slices (complete briefs, disjoint scopes); render each worker's brief with the standing orders; watch them (STUCK, PR, CI, verdict, landed); create and release slice worktrees; gate fan-in on scope, merge conflicts and landing order |
| `workit verify-delivery [push\|pr\|merge\|release]` | Confirm on the remote that it landed |
| `workit release start\|finish\|publish` | git-flow releases without the git-flow binary: cut, finish (merge, tag, merge back) and publish per release track |
| `workit youtrack note\|time\|meeting` | YouTrack comments and work time |
| `workit changelog apply` | Add entries under the changelog's Unreleased section |
| `workit <family> <action>` | Low-level task families: `task`, `policy`, `evidence`, `finding`, `decision`, `worker`, `state` |

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
| `blocked` (exit 3) on push/PR/merge | `grant_endpoint`, `github_identity`, `gitlab_identity` | Read `unblock` in the output: usually a missing grant (`workit grant show`) or a `gh`/`glab` login that is not the workspace account |
| Agents get permission prompts for `workit` verbs | `claude_permissions`, `codex_permissions`, `cursor_permissions`, `*_grant_rules` | `workit setup` in your own terminal |
| Hook answers `workit context skipped: host under load` | `hook_deadline` | Rare under normal load; see the [Claude Code guide](docs/guides/claude-code.md) for `WORKIT_HOOK_DEADLINE_MS` |
| Store grows large | none | `workit gc --dry-run`, then `workit gc` |
| `recovery` copies from 2.x reported | none | `workit gc --prune-recovery --yes` |
| Claude Code hook prints `[workit] Claude Code hook unavailable` | `claude_plugin`, `claude_session_plugin` | The hook failed open: install Bun for a local pin, or `workit upgrade` and restart Claude Code |
| Codex hooks do not run | `codex_hooks` | Trust them with `/hooks` in Codex |
| Codex verifier or reviewer agents missing | `codex_agents` | `workit upgrade`, then a new Codex session |
| OpenCode fails `opencode_version` | `opencode_version` | Upgrade OpenCode to 2.0.18+ |
| Pi does not load Workit | `pi_extension` | See [Pi](docs/guides/hosts.md#pi) |

More: [configuration and storage](docs/guides/configuration.md).

## Documentation

- Guides: [Claude Code](docs/guides/claude-code.md) ·
  [Other hosts](docs/guides/hosts.md) ·
  [Verification](docs/guides/verification.md) ·
  [Delivery and stacks](docs/guides/delivery.md) ·
  [Grants](docs/guides/grants.md) ·
  [Configuration](docs/guides/configuration.md) ·
  [Migration](docs/guides/migration.md)
- Design record: [`docs/workit-next/`](docs/workit-next/spec.md)
- Release qualification: [`docs/qualification/`](docs/qualification/qualification.md)
- History: [`docs/archive/`](docs/archive/README.md) · [CHANGELOG](CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent and maintainer conventions for
this repository live in [AGENTS.md](AGENTS.md), [`docs/agents/`](docs/agents/) and [CODING_STANDARDS.md](CODING_STANDARDS.md).

## License

[MIT](LICENSE)
