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

Requires **Node.js 24+**. The setup wizard detects your hosts, installs the
ones you pick with their native commands, and writes your global config:

```bash
npx @brainervirus/workit-cli init
workit doctor          # after a global install (npm i -g @brainervirus/workit-cli)
```

Or install a single host by hand:

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude plugin marketplace add BrainerVirus/workit
claude plugin install workit@workit
# update later (Claude Code does not auto-update plugins by default):
claude plugin marketplace update workit && claude plugin update workit@workit
```

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

Local pin: build once with `bun packages/workit-opencode/scripts/build.ts`, then
use `"plugins": ["file:///path/to/workit/packages/workit-opencode"]`. OpenCode
1.x must stay on `@brainervirus/workit-opencode@2`.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `npx @brainervirus/workit-cli init` and select Cursor: it installs the
plugin (MCP server, session hook, contract rule, skills). Manual MCP setup is
in [the hosts guide](docs/guides/hosts.md#cursor).

</details>

<details>
<summary><strong>Codex CLI / desktop</strong></summary>

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workflow-toolkit
```

Skills are invoked as `$workit-<name>` or from the `/skills` picker.

</details>

<details>
<summary><strong>Pi</strong> (0.85.1)</summary>

```bash
pi install npm:@brainervirus/workit-pi
pi install ./packages/workit-pi -l --approve   # local checkout
```

</details>

<details>
<summary><strong>CLI only</strong></summary>

```bash
npm i -g @brainervirus/workit-cli
workit help
```

Every verb works without a host; hosts just put `workit` and the skills in
front of the agent.

</details>

## Core concepts

**Implicit task per branch.** The first note, check, ledger record or commit
on a branch creates its task; every task command without an id applies to it.
State lives in the git common directory (`.git/workit/`, shared by all
worktrees) as an append-only event log. `workit task status` shows it;
`workit handoff` prints a resume brief.

**Observed evidence (`workit check`).** `workit check test` runs the configured
command (from a committed `workit.checks.json`, else detected defaults such as
`<pm> run test`, `go test ./...`, `cargo test`, `pytest`) and records exit
code, HEAD and tree. Gates accept only a fresh passing run of a configured
check; a check is stale once the worktree changes. Ad-hoc
`workit check -- <cmd>` runs are recorded but never satisfy a gate.

**Ledger verdicts (author ≠ verifier).** `workit ledger verdict` records a
result (`verified`, `tests-verified`, `type-check-only`, `blocked`, `failed`)
for a branch head under the acting session. A verdict from the session that
authored the commits is never accepted. Verdicts carry across rebases when
the patch-id and diff are unchanged. `workit ledger check` answers "is this
head independently verified?".

**Autonomy grants.** Per-workspace grants in `~/.config/workit/workspaces.json`
set the ceiling: `push`, `pr` and `rerun` are allowed by default; `merge` needs
`true` or `verified`, and both merge only with an accepted independent verdict
(`true` also allows a ledger-recorded `--unverified --reason` bypass);
`defaultEndpoint` is where an unnamed delivery request
stops: `commit` (default), `pr` (push and open the PR), `green` (open the PR,
then babysit CI, review threads and required rebases until it is merge-ready,
never merging) or `merged` (`green`, then `workit pr merge`; it acts as `green`
until the workspace has the merge grant). Without the `push` or `pr` grant any
of them acts as `commit`; `workit grant show` reports the effective endpoint. Raising a grant or the endpoint needs
you at a terminal; agents can only lower them. See
[grants](docs/guides/grants.md).

**Policy.** Judge tracked work in four calls (`workit policy assess --judge
risk=trivial|normal|high behavior=yes|no product-choice=yes|no plan=yes|no`,
or the flat `workit_policy` tool fields) and Workit derives what it needs:
nothing for trivial work, an observed `workit check test` and a verdict for a
behavior change (the author's own, shown as self-reviewed, unless the
workspace sets `verification: "independent"`), an independent live verdict and
a plan for high risk. An open product choice or a needed plan blocks code
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
4. **Ship**: `workit git push`, `workit pr create`, `workit ci wait`,
   `workit pr status`; `workit pr merge` only when the PR is READY, verified and
   the `merge` grant allows it. `workit verify-delivery` confirms it landed.

For independent slices, **fanout** runs one worker per isolated worktree with
a fixed brief and file-scope manifest, and a non-author verifier per slice.
`workit fanout plan` refuses incomplete briefs and overlapping scopes before
any spawn, `workit fanout brief` renders each worker's brief with the lead's
standing orders (`workit ledger standing`), `workit fanout status` flags
stuck workers and suggests a landing
order, `workit fanout worktree create|release` isolates workers on hosts
without native worktrees, and `workit fanout check` gates fan-in. See
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

`workit help <command>` prints the exact usage of any verb. Global flags:
`--json` (envelope `{"ok","code","data","error"?,"unblock"?}`), `--cwd <dir>`,
`--version`. Exit codes: `0` ok, `1` failed, `2` usage, `3` blocked,
`4` busy/pending, `5` unavailable.

| Command | Purpose |
| --- | --- |
| `workit init` | Interactive setup wizard (hosts, config, optional project files) |
| `workit doctor [--json] [--fix-lock]` | Offline installation health; clear a stale store lock |
| `workit upgrade [--apply --confirm]` | Preview, then apply, package and config upgrades |
| `workit launch <host> --auto-upgrade` | Upgrade, then start a host |
| `workit gc [--dry-run]` | Compact task logs, drop unreferenced blobs and old check logs |
| `workit uninstall` | Remove host registrations (keeps `~/.config/workit`) |
| `workit grant show\|set\|unset` | Workspace autonomy grants and `defaultEndpoint` |
| `workit task status\|start\|note\|close\|adopt` | The current branch's task |
| `workit handoff` | Resume brief: branch, HEAD, dirty state, verdict, next command |
| `workit check <name>` | Run a configured check and record observed evidence |
| `workit test-audit [--diff] [--mutate]` | Flag tautological tests; optional diff-scoped mutation |
| `workit knowledge lint` | Lint AGENTS.md budget, local links, scaffold-only and duplicated rules; register as `workit check knowledge` |
| `workit ledger decision\|ruling\|verdict\|standing\|list\|check` | Decisions, rulings, SHA-keyed verdicts and a fanout's standing orders |
| `workit git branch\|commit\|push` | Policy-checked branch/commit; leased push with verified remote tip |
| `workit pr status\|create\|merge` | PR state and next action; SHA-bound create; gated merge |
| `workit ci wait\|rerun` | Wait for CI on the PR head; rerun failed jobs once per head |
| `workit stack plan\|status\|sync\|land` | Base-branch PR stacks |
| `workit fanout plan\|brief\|check\|status\|worktree` | Register parallel slices (complete briefs, disjoint scopes); render each worker's brief with the standing orders; watch them (STUCK, PR, CI, verdict, landed); create and release slice worktrees; gate fan-in on scope, merge conflicts and landing order |
| `workit verify-delivery [push\|pr\|merge\|release]` | Confirm on the remote that it landed |
| `workit youtrack note\|time\|meeting` | YouTrack comments and work time |
| `workit changelog apply` | Add entries under the changelog's Unreleased section |
| `workit <family> <action>` | Low-level task families: `task`, `policy`, `evidence`, `finding`, `decision`, `worker`, `state` |

## Upgrading

Upgrade every host together: newer store records are refused by older
runtimes. `workit upgrade` previews; `--apply --confirm` applies with a backup.

| From | Key breaks |
| --- | --- |
| 2.x → 3.0 | OpenCode V1 adapter removed (OpenCode 2.0.18+; 1.x stays on `workit-opencode@2`); `workit cutover` removed |
| 3.x → 4.0 | Task state moves to `.git/workit/` event store, implicit task per branch; old `.workit/` migrates on first CLI use (backup kept) |
| 4.x → 5.0 | Skill set v3: 16 skills merged into 11; old `wk-*` aliases removed; `ledger verdict --as` never makes the author independent |
| 5.x → 6.0 | Approval receipts, `autoApprove`, managed external actions and the writer/checkout lease are gone; authority is host permissions plus autonomy grants |

Details and the skill rename table: [migration guide](docs/guides/migration.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Something is off after install or upgrade | `workit doctor` (or `--json`); each finding names its repair |
| Hook says `workit migration pending` | Run `workit task status` once in that checkout; hooks never migrate |
| A command returns `busy` (exit 4) | Another workit process holds the store or stack lock; retry. A dead holder is reclaimed automatically; `workit doctor --fix-lock` clears a stale one |
| `blocked` (exit 3) on push/PR/merge | Read `unblock` in the output: usually a missing grant (`workit grant show`) or a `gh`/`glab` login that is not the workspace account |
| Store grows large | `workit gc --dry-run`, then `workit gc` |
| `recovery` copies from 2.x reported | `workit gc --prune-recovery --yes` |
| Claude Code hook prints `[workit] Claude Code hook unavailable` | The hook failed open: install Bun for a local pin, or reinstall the plugin |
| OpenCode fails `opencode_version` | Upgrade OpenCode to 2.0.18+, or pin `@brainervirus/workit-opencode@2` |

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
