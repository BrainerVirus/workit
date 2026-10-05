# Workit

Multi-platform Workit workflow support for Cursor, OpenCode, Codex CLI/desktop,
Pi, Claude Code, and the CLI. The hosts share one task contract and seven operation families
while adapting authority and lifecycle behavior to the native surfaces each
host documents.

Compact task continuity surfaces the newest decisions with bounded, redacted
choice summaries; full records remain available through explicit inspection.
For substantial work across repositories, keep each unfinished item's checkout,
branch, requested deliverables and delivery endpoint in a concise checkpoint.
Verify named deliverables and the requested destination result before reporting
completion; a local commit does not prove a remote push.

| Package     | Purpose                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| OpenCode    | Native plugin with eleven method skills, nine tools (seven shared families plus read-only context and init apply), and provider-safe schemas |
| Cursor      | MCP transport, one native hook dispatcher, one contract rule, and eleven skills  |
| Codex       | Native plugin manifest, shared MCP transport, documented lifecycle hooks, and eleven skills |
| Claude Code | Native plugin: session/per-turn task context hooks, branch policy on git shell commands, eleven skills, and verifier/reviewer/implementer agents |
| Pi          | Native npm extension with eight tools (seven shared families plus read-only context), eleven skills, and session continuity |
| Shared MCP  | Low-level transport for the seven core operation families                       |
| Shared core | Task, policy, evidence, finding, decision, worker, and continuity state         |
| CLI         | Setup wizard (`workit`)                                                         |

## Install

Requires **Node.js 24 or newer**. The wizard detects your hosts, configures the
OpenCode, Cursor, Codex, Pi and Claude Code installations you pick, and writes your global config and optional project files:

```bash
npx @brainervirus/workit-cli init
```

`workit init` is an interactive TTY wizard with a short basic path and optional
advanced setup. Detected hosts are selected initially; unavailable hosts are
disabled. Select all available, clear all, or pick individual hosts. Installation
uses native package/plugin commands and shows the changes before applying them;
it does not install the host applications or reload your running sessions.

Advanced setup edits workspace hosting and issue tracking independently, branch
and commit policies, profiles/default profiles, and named release tracks. Narrow
workspace globs override broader matches regardless of file order; equal-specificity
ambiguity is reported. Choose inheritance to remove an override. Existing
workspace choices and custom fields survive edits, including when changing the
default tracker for new workspaces. GitHub and GitLab can both link YouTrack;
GitHub Issues requires GitHub hosting.

GitHub and GitLab use `gh auth login` / `glab auth login`; Workit does not create
or read separate VCS token files. YouTrack retains its permanent token. Existing
VCS token files and templates stay untouched. Project setup defaults to No:
press `n` to skip adding files when configuring from a parent folder containing
multiple repositories. Press `y` only to add hygiene files and gitignore entries
to the displayed directory. Locale keeps its existing selection until changed.
`workit doctor` checks the configured installation.

YouTrack is optional and everything organization-specific comes from
`youtrack.json`; there are no built-in hosts, issues or wording:

- `baseUrl` is required. Without it the token-create link is unavailable and
  the error names the config file.
- `meetingIssue` / `meetingIssues` choose the meeting issue(s); meetings mode
  asks for one when none is configured. Meeting time uses each entry's
  `workItemText`, else a global `meetingWorkItemText`, else `Meetings`.
- Work-item dates are a calendar day sent as that day's UTC midnight. "auto"
  means today in the process timezone (honouring `TZ`); an IANA `timezone` in
  `youtrack.json` overrides it. YouTrack context reports the effective zone as
  `workTimezone: { timezone, source }` (`source` is `youtrack.json` or
  `process`). Resolved `youtrack.update` / `youtrack.meeting` /
  `youtrack.time` actions (and the `workit youtrack` verbs) report
  `workDate: { localDate, timezone, timezoneSource }`. An explicit epoch `dateMs` is labelled with its UTC day.
- Workit adds no greeting or `@mention` to comments. The text comes from the
  editable `issue-update` template (`templates/issue-update.md` in the config
  directory overrides the bundled neutral one); placeholders Workit does not
  fill, such as a legacy `{{greetingSection}}`, render empty.

Older configs load unchanged: a `timezone` in the global `config.json`, and
`defaultMention`, `greetings` or `greetingCutoff` in `youtrack.json`, are
ignored.

Manual setup per tool:

<details>
<summary><strong>OpenCode</strong> — native plugin</summary>

Run the wizard and select OpenCode, or add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@brainervirus/workit-opencode"]
}
```

`workit init` writes that same npm package pin for published installs. A
checkout/dev install may pin `file://…/packages/workit-opencode/…` instead.
Do not pin into pnpm dlx or `_npx` cache paths — those break when the cache is
cleared.

Requires OpenCode 2.0.18+ and Node.js 24+. The plugin uses the OpenCode V2
plugin API (`setup()`) with nine native tools, eleven method skills and
`wk-*` commands, and direct-child delegation. Workit 3.0
removed the OpenCode 1.x (V1 `server()`) adapter; stay on Workit 2.x for an
OpenCode 1.x host. The published plugin is a self-contained Node bundle (no
runtime `@opencode/plugin` dependency).

**OpenCode 1.x: stay on Workit 2.x.** OpenCode 1.x reads the V1 `plugin` key
and can only load the V1 `server()` entry, which Workit 3 removed. Pin the 2.x
line there:

```json
{ "plugin": ["@brainervirus/workit-opencode@2"] }
```

OpenCode 2.x reads `plugins` (and still normalizes a `plugin` key), so after
upgrading OpenCode to 2.0.18+ use `"plugins": ["@brainervirus/workit-opencode"]`.
`workit doctor` fails `opencode_version` on a 1.x CLI with this fix, and
`workit upgrade` warns before applying.

</details>

<details>
<summary><strong>Cursor</strong> — plugin, MCP transport, and hooks</summary>

Run the wizard and select Cursor: it registers the plugin, the MCP server, the
session hook, the contract rule, and the eleven skills.

Or add the published launcher to the Cursor MCP config:

```json
{
  "mcpServers": {
    "workit": {
      "command": "npx",
      "args": [
        "-y",
        "--prefer-online",
        "--min-release-age=0",
        "--package=@brainervirus/workit-cursor@latest",
        "workit-cursor-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

`@latest`, `--prefer-online`, and `--min-release-age=0` are intentional: the
runtime resolves from npm at launch despite npm/cli#9765, where `npx` ignores
scoped `min-release-age-exclude` settings. The wizard also copies
the plugin into `~/.cursor/plugins/local/workit` as a **real directory** (not a
symlink into pnpm dlx/`_npx` caches). Requires Node.js 24+ and network access on
first run. Plugin metadata lives under `.cursor-plugin/` and is
submission-ready for the Cursor Marketplace; it is not published there.

</details>

<details>
<summary><strong>Codex CLI / desktop</strong> — plugin manifest and shared MCP</summary>

Select Codex in the wizard, or use its native marketplace installer:

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workflow-toolkit
```

The marketplace references the built npm package, so installation does not depend
on unbuilt Git checkout artifacts. The plugin includes hooks and the shared MCP
server. Native Codex permission and sandbox settings remain authoritative.

Reads run over MCP; mutations run CLI-driven because MCP is read-only for
unattested callers:

```bash
node_modules/.bin/workit <family> <action> --json [--actor <session-id>]
```

Requires Node.js 24+ and Codex CLI or desktop. The hook honors exactly the
bound session and nothing else.

</details>

<details>
<summary><strong>Claude Code</strong> — plugin (latest published, or pinned to a checkout)</summary>

**Latest published.** The repository root is a Claude Code marketplace
(`.claude-plugin/marketplace.json`) whose entry installs the published
`@brainervirus/workit-claude-code` npm package. Select Claude Code in the
wizard, or install natively:

```bash
claude plugin marketplace add BrainerVirus/workit
claude plugin install workit@workit
# later: refresh the marketplace, then update (Claude auto-update is off by default)
claude plugin marketplace update workit && claude plugin update workit@workit
```

`workit doctor` warns (`claude_plugin`) when a newer plugin version is
published than the one installed. `workit uninstall` previews and runs the
native `claude plugin uninstall workit@<marketplace> --scope <scope>` for each
Workit install that applies where you run it: user scope, plus project/local
scope installs of the current project (run from that project).

**Local pin to a checkout.** Load the package straight from this repository;
hooks and `workit` on the Bash tool then run the TypeScript sources with Bun,
so edits apply without rebuilding the plugin. Only the generated skills need a
build step:

```bash
bun install
bun packages/workit-claude-code/scripts/build.ts --skills-only   # generate skills/
claude --plugin-dir "$PWD/packages/workit-claude-code"           # one session
# every session: export it from your shell profile instead
export CLAUDE_CODE_PLUGIN_DIRS="$HOME/path/to/workit/packages/workit-claude-code"
```

Disable the marketplace install while pinning (`claude plugin disable
workit@workit`) so the two copies do not both load. A pinned checkout needs
Bun on `PATH`; an installed plugin needs only Node.js 24+.

The plugin ships:

- hooks: `SessionStart` (startup/resume/clear/compact/fork) injects the Workit
  contract and task context and exports `WORKIT_HOST`/`WORKIT_SESSION_ID` to
  the session's shell; `UserPromptSubmit` re-injects task context only when it
  changed since it was last injected; `PreToolUse` on `Bash`/`PowerShell`
  `git *` commands denies protected or non-compliant branch operations with a
  structured `permissionDecision: "deny"` (Claude Code 2.1.288 shows it as
  `PreToolUse:Bash hook error: <reason>`; it never answers `allow`, so your
  permission prompts stay in charge); `SubagentStart` tells the `implementer`
  it works in its own worktree and other subagents that they are read-only.
  No other events are registered;
- fail-open: if the hook runtime cannot start (no Bun for a pin, a missing or
  unloadable `dist/`), the hook answers nothing and prints one
  `[workit] Claude Code hook unavailable: …` line, and Claude runs as if Workit
  were not installed;
- skills: the eleven method skills, namespaced as `/workit:<name>`
  (`/workit:review`, `/workit:shape`, …);
- agents: `verifier` and `reviewer` (read-only) and `implementer`
  (`isolation: worktree`);
- `workit` on the Bash tool's `PATH` (the plugin `bin/`).

No MCP server is registered: Claude has a shell, and tool schemas cost
resident context. To opt in, add `workit-mcp` to your own Claude settings.

</details>

<details>
<summary><strong>Pi</strong> — native extension</summary>

Install the package alongside the Pi peer dependency (Pi 0.85.1):

```bash
pi install npm:@brainervirus/workit-pi         # published package
pi install ./packages/workit-pi -l --approve   # this checkout (local development)
```

Pi discovers the extension and skills through the `pi` manifest section of the
package (`./dist/workit.js` plus `./skills`); see the Pi documentation for how
your setup resolves extension packages. Requires Node.js 24+.

</details>

<details>
<summary><strong>CLI</strong> — setup, task control, and diagnostics</summary>

```bash
npm i -g @brainervirus/workit-cli
# or run without installing:
npx @brainervirus/workit-cli init
```

```bash
workit init              # basic / advanced setup wizard
workit upgrade           # read-only package and config upgrade preview
workit upgrade --apply --confirm  # apply a reviewed preview
workit upgrade --cli --apply --confirm  # also update an existing global CLI
workit launch pi --auto-upgrade --  # update before starting Pi
workit doctor            # offline installation health report (--json for machines)
workit doctor --fix-lock # clear a stale workit store lock (WORKFLOW_WORKSPACE_ROOT or cwd)
workit doctor --fix-lock --force [--yes]  # clear a lock whose owner cannot be verified
workit gc [--dry-run]    # compact long task logs, drop unreferenced blobs and old check logs
workit task status [--all]          # the current branch's task (no ids; --all: every task in the store)
workit task start "<objective>"     # optional: name the branch's task (idempotent per branch)
workit task note "<text>" [--next "<t>"]  # progress; creates the branch's task on first use
workit task close [--outcome verified|limited|stopped]
workit task adopt <id>              # bind a migrated 2.x (or other checkout's) task to this branch
workit <family> <action> [--payload <json|@file|->] [--task <id>] [--actor <id>] [--json]
workit grant show [<workspace>] [--all]  # effective autonomy grants and defaultEndpoint
workit grant set <workspace> <kind>=<true|false|verified>… [defaultEndpoint=commit|pr]
workit grant unset <workspace> <kind>…  # back to the default
workit youtrack note <ISSUE> (--markdown <t>|--file <p>) [--minutes n] [--date auto|YYYY-MM-DD]
workit youtrack time|meeting <ISSUE> --minutes n [--text t] [--date …]
workit changelog apply (--entries <JSON|@file|->|--normalize-only) [--path CHANGELOG.md] [--preview]
workit handoff --task <id> [--json]
workit pr status [--pr <n>] [--json]  # checks + failing log tails, open threads, behind-base, next action
workit ci wait [--timeout 20m] [--json]  # exit 0 green, 1 red, 4 still pending at the timeout
workit ci rerun --failed --reason flake|infra [--force]  # once per PR head without --force
workit git branch feature/x [--base <b>]  # policy-checked name, from the fetched default target
workit git commit -m "feat: x" -- <paths>  # convention-checked; --all to take every change
workit git push [--set-upstream] [--force-with-lease]  # exact SHA, remote tip verified after
workit pr create (--title <t> | --fill) [--base <b>] [--draft]  # head bound to the pushed SHA
workit pr merge [--pr <n>] [--method squash|merge|rebase] [--delete-branch]
workit verify-delivery [push|pr|merge|release]  # exit 1 when it did not land
workit stack plan [<bottom> … <top>]  # record a base-branch chain (default: the current branch's)
workit stack status      # per PR: next, checks, verdict, on parent; READY|WAITING|ADVANCE|COMPLETE
workit stack sync [--local] [--dry-run] [--force <branch>]  # restack after a merge, lease push, retarget PR bases
workit stack land [--dry-run] [--max <n>]  # merge the contiguous verified run from the root
workit check test        # run a configured check and record CLI-observed evidence
workit check --name test -- bun test  # same, if argv is exactly the configured command
workit uninstall         # remove host registrations (keeps ~/.config/workit)
```

`pr status` and `ci` read GitHub through `gh api` and GitLab through
`glab api`, pick the forge from the push remote host (PRs of a fork are
looked up in its parent or `upstream`), and pass the workspace account's
credential on every call (`vcs.tokenFile`, else `gh auth token --user
<vcs.account>`) without switching the active `gh`/`glab` account. A login
that is not the workspace `vcs.account` is `blocked` (exit 3) with a login
hint. `next` also reports review, draft, merge-queue and other merge
blockers; only required checks gate. `pr status` never moves a ref, and
every forge and git network call has a timeout.

`workit check` runs the command (no shell unless `--shell "<cmd>"`; on
Windows `.cmd` shims run through an escaped `cmd /d /s /c`), streams its
output, and records the exit code, duration, HEAD, worktree tree key and
patch-id as `observer: workit_cli` evidence in the run ledger and in the
current task. The exit code is the command's; `--timeout` kills the whole
process tree. Close-time testing and verification gates accept only a fresh
passing run of a configured check (or an approved limitation); an
agent-recorded "tests pass" is a note and an ad-hoc `workit check -- <cmd>`
never satisfies a gate. Configured checks come from a committed
`workit.checks.json` (`{"checks":{"test":"bun test"},"gates":{"testing":"test"}}`),
else detected defaults (package.json `test`/`lint`/`typecheck`/`check` as
`<pm> run <script>`, `go test ./...`, `cargo test`, `pytest`, `make test`).
`testing` binds to `test`. A check is stale once the worktree changes, or if
the check itself changed it.

The delivery verbs do the mechanical part of shipping and record what they
observed in the run ledger. `git branch` and `git commit` apply the workspace
branch and commit policy, never commit to a protected branch, and never sweep
in changes you did not name. Commits carry a `Workit-Session:` trailer and a
`commit.recorded` row, so the authoring session cannot verify its own work.
`git push` never pushes a protected branch and succeeds only when the remote
tip equals the local SHA afterwards. It forces only with
`--force-with-lease`, leased on the tip workit itself last pushed (a no-op
push is recorded as `push.noop` and never counts), never on a tracking ref a
plain `git fetch` may have moved. Without that record it needs
`--expect <sha>`. In both cases the remote tip must be in the branch's
history or reflog (`--force-if-includes`); only `--overwrite-unintegrated`
drops commits you never had. `pr create` requires the branch to be pushed and checks
that the forge reports that SHA as the PR head. `pr merge` merges only when
`pr status` reads READY, an independent verdict is accepted for that head
(`workit ledger check`), and the workspace `merge` grant allows it. The merge call
carries the head SHA, so a head that moved is refused. `--delete-branch`
never deletes a protected branch, the base or the default target.
`verify-delivery` answers "did it land?" from the remote, never from local
state.

`stack` manages plain base-branch chains (root PR on the trunk, each child PR
on its parent branch) on GitHub and GitLab; it needs neither Graphite nor
`gh stack`. The order is cached in `<git common dir>/workit/stacks/`, so every
worktree shares it and it outlives a removed worktree, and one command at a
time may change a stack (a second one answers `busy`; a holder that stopped
heartbeating, or a dead process on this machine, is reclaimed). `stack sync`
restacks each remaining branch onto its parent after a merge
(`git rebase --onto`; squash merges always need this) in the worktree that
has it checked out, or in a temporary worktree under the store, never moving
your checkout. Before anything is pushed the moved branch must be the same
change (exact diff against its base, no commit dropped); otherwise it is
`blocked` with `content_changed`, the rebased branch stays local, and only
`--force <branch>` pushes it. The check compares the commits actually rebased
(remembered across a conflict) with the result, so your own new commits on a
child are fine. A long rebase never loses the stack lock to another command. Branches with merge commits are refused (a plain rebase
would drop their resolutions). It pushes through `git push`'s lease and
retargets the PR, and a conflict stops it with the rebase left in progress:
resolve, `git rebase --continue`, then `workit stack sync`. `--local` skips
the forge and so cannot see squash merges. When a restacked branch carries
the same change (same patch-id and exact diff), its verdict carries; CI
always runs again. `stack land` merges only the contiguous run from the root
whose PRs still belong to their branch in this repository, target the trunk,
read READY and have an accepted verdict, one at a time through `pr merge`'s
gates. After each merge it moves the next PR onto the trunk and waits for its
CI, and it stops at the first PR that does not qualify with the reason
(`no_verdict`, `not_ready`, `pr_mismatch`, `grant_required` = verified and
ready but not allowed to merge, …).
`--dry-run` changes nothing. `pr status` also reports the head's verdict.

`git push`, `pr create`, `pr merge`/`stack land` and `ci rerun` check the
workspace's push, pr, merge and rerun grants (see
[Autonomy grants](#autonomy-grants-per-workspace)); `youtrack` and `changelog`
verbs are gated by host permission only.

The packed CLI is a self-contained Node bundle; Node.js 24+ is required.

</details>

<details>
<summary><strong>Upgrading a legacy install</strong></summary>

`workit doctor` reports `stale_install` when a legacy selector or a
local-dist install is behind the current runtime, or when OpenCode's
frozen `@latest` package cache lags published `workit-opencode`, with the
exact repair step; Cursor canonical `@latest` installs never fail on
version metadata.

</details>

### Upgrades

**Workit 5.0 (breaking).** The approval tickets chain (host question answers,
Pi confirmations, CLI TTY confirmations), standing `autoApprove`, managed
external actions (`workit action`, Pi's `workit_external_action`) and the
checkout lease (its tool and CLI verb) are gone; authority is
host permissions plus [autonomy grants](#autonomy-grants-per-workspace). A 4.x
host reading a store record written by 5.0 reports "record was written by
workit 5.x; upgrade Workit", so upgrade all hosts together.

`workit upgrade` checks the selected Workit registrations, queries npm, and
previews targeted updates and supported configuration migrations. Use
`--hosts=opencode,cursor,codex,pi` to limit the hosts. Applying requires
`--apply --confirm`, backs up affected configuration under
`~/.local/state/workit/upgrades/`, rejects changed configuration, and verifies
the requested installed version. Local checkout sources and intentional version
pins remain unchanged. OpenCode JSONC configuration requires native inspection
before an automatic update. `--cli` updates an existing global npm CLI install (`--hosts=none` targets only the CLI); for
an ephemeral install, run `npx @brainervirus/workit-cli@latest` instead.

OpenCode 2.0.21 cannot target a server plugin with its `plugin update` command
(verified in the official Docker image). Workit reports that limitation and
preserves the OpenCode registration; it never falls back to updating every
plugin or deleting caches. OpenCode package resolution remains host-owned.
Cursor, Codex and Pi use their supported scoped update paths.

Automatic updates are opt-in: `workit launch <host> --auto-upgrade -- <args>`
updates before starting that host. Stop other instances of the selected host
first; Workit refuses to replace loaded plugins. A registry outage starts the
unchanged installation with a visible warning; an installation or verification
failure stops the launch. Native startup hooks do not run competing installers.
This does not migrate task history, change host permissions, or change package
pins. Re-run the preview after resolving a failure rather than blindly retrying.

## Upgrading to skill set v3

Skill set v3 has eleven skills, down from sixteen. Each removed skill was merged
into one of the new ones, and its `wk-*` alias was removed with it:

| Old skill (alias) | Now |
| --- | --- |
| `workit-challenge` (`/wk-challenge`), `workit-plan` (`/wk-plan`), `workit-diagram` (`/wk-diagram`), `workit-mockup` (`/wk-mockup`) | `workit-shape` (`/wk-shape`); diagrams and mockups are references inside it |
| `workit-behavioral-tdd` (`/wk-tdd`) | `workit-bdd` (`/wk-bdd`) |
| `workit-blast-radius` (`/wk-blast-radius`) | `workit-review` (`/wk-review`) |
| `workit-babysit` (`/wk-babysit`), `workit-green-run` (`/wk-green-run`) | `workit-ship` (`/wk-ship`) |
| `workit-steer` (`/wk-steer`), `workit-handoff` (`/wk-handoff`) | `workit-continue` (`/wk-continue`) |
| (new) | `workit-fanout` (`/wk-fanout`), `workit-verify-app` (`/wk-verify-app`) |

On Claude Code the skills are `/workit:<name>` (for example `/workit:shape`).

Verifiers and reviewers record `workit ledger verdict` under their own session.
The lead starts each one with `WORKIT_SESSION_ID=<lead>-v<n>`; on Claude Code
the SubagentStart hook names one. An author's session is always refused, and
`--as <role>` only makes verifier ids distinct; it never makes the author
independent.

When you name no endpoint, the agent stops at a local commit. It pushes and
opens a PR when you ask it to deliver, or when `workit grant show` reports
`defaultEndpoint` `pr`.

## What it provides

- Seven shared `workit_*` operation families: task, policy, evidence, finding,
  decision, worker, and state. Decisions are agent-asserted durable records
  that satisfy decision requirements; they never authorize an effect.
- Eleven canonical method skills: shape (brainstorm, grill, slice, durable
  knowledge only when it pays), implement, review, debug, ship (PRs, stacks,
  CI, landing), continue (interruptions and handoff), bdd, test-audit,
  deslop, fanout (parallel workers with fixed briefs and independent
  verifiers) and verify-app (generates a project `verify-<app>` skill).
- A `<workit-contract>` bootstrap marker carrying shared invariants.
- Host-native capability reporting that never fabricates authority,
  delegation tokens, or cross-process identity.

Mechanical tasks with a `self-review` requirement accept the lead's own fresh
review evidence, with `reviewContext` matching the recording session. Independent
review requirements still need a session distinct from the task creator and
other evidence recorders.

`task.list` defaults to the 20 most recently updated active or paused tasks and
returns a compact projection. Use `status: "closed"` or `status: "all"` with a
`limit` of 1-50 for bounded history, then `task.inspect` for one task's details;
omitting its `view` selects `summary`. Closed inspection uses the candidate
captured at closure.

Skills are reachable two ways: model-invoked automatically when the task fits,
or explicitly via the available `wk-*` aliases (`/wk-shape`, `/wk-implement`,
`/wk-ship`, `/wk-fanout`, `/wk-debug`, and the rest) on OpenCode, Cursor, and
Pi. On OpenCode, each alias asks the model to load its matching method skill;
it does not chain to another alias, and a user skill with the same ID suppresses
that Workit alias. Codex CLI has no slash path: invoke skills explicitly as
`$workit-<name>` or from the `/skills` picker. Creating a PR does not auto-start
babysit; `babysit:true` opts into PR-ready follow-up and does not authorize
merge or release. A PR URL from a route Workit did not enforce can be babysat
when the user asks, without claiming enforcement. Raw
branch naming checks run only for direct, unquoted literal forms of
`git switch -c|--create|-C|--force-create`, `git checkout -b|-B`, and
`git branch <name>`. A recognized target that violates the current workspace
policy is denied with a correction; compliant commands pass to the host. PR,
worktree, compound, quoted, variable-expanded, wrapped, and other shell forms
remain host-governed. Workit is not an OS sandbox, so use repository or provider
controls when policy must cover unsupported shell forms.

## Host surfaces

Each adapter maps the shared contract to what the host can actually attest.

<details>
<summary><strong>Cursor</strong></summary>

Cursor uses the shared MCP transport and one bounded native hook executable.
AskQuestion is policy-only (`agent_guided`); session start and compaction are
non-blocking; arbitrary shell writes, Tab edits, and stable subagent-stop
identity are unavailable. Reviewer and investigator native delegation is
read-only. Implementer delegation is unavailable because Cursor exposes no stable
child-stop identity. MCP is read-only for unattested callers; mutations run
through `node_modules/.bin/workit <family> <action> --json`. Cursor ships only
`rules/workit-contract.mdc`, which documents the shared contract, exact
workspace/session scope, read-only native delegation, and the surfaces Cursor
cannot attest or block.

</details>

<details>
<summary><strong>Codex CLI / desktop</strong></summary>

Codex CLI and desktop use the same shared transport and native hook bundle;
their surface qualification remains separate. Codex hooks provide bounded
known-write guardrails and read-only/agent-guided subagent observations;
mutations run through the CLI.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

Claude Code runs one hook process per event (`node bin/workit-hook.mjs`, exec
form, no shell) through the shared host-hook protocol. Branch policy denies use
`permissionDecision: "deny"` with the unblock hint in the reason; Workit never
emits `allow`. `PreCompact` cannot inject context, so the task context is
restored by `SessionStart` with `source: "compact"` (no `PreCompact` hook is
registered). `SubagentStart` can only add context, never block or bind: the
worktree `implementer` is told it may edit and commit in its own worktree after
switching to a policy-compliant branch (Claude names worktree branches itself),
and every other subagent is observed as read-only/agent-guided.

</details>

<details>
<summary><strong>Pi</strong></summary>

Pi loads `@brainervirus/workit-pi` through its native package manager and reads
the package's `pi.extensions` and `pi.skills` manifest entries. The extension
uses Pi's native session identity and known write/edit tool boundary with the
shared core; Pi project trust still gates mutations. Arbitrary shell writes remain agent-guided because Pi extensions
are not an OS sandbox. Its bundled coordinator can launch fresh stock-Pi
reviewer/investigator processes and explicitly scoped implementers (which
no longer acquire a checkout lease); cancellation timeouts remain uncertain until an exit is observed. Pi also exposes one
child-disabled `workit_worker_control` host-orchestration tool for
launch/cancel/reconcile; the shared core surface remains the seven `workit_*`
operation families plus read-only `workit_context` (the orchestration tool is
adapter-owned, not an eighth family).

</details>

<details>
<summary><strong>Worker dispatch</strong></summary>

Hosts that can observe their own launch surface durably claim a worker's launch
slot (persisted state `dispatching`) before spawning it, through the host-only
core methods `prepareWorkerDispatch` and `commitWorkerDispatch`. Only the live
reservation settles the claim exactly once: either the observed child session
binds the worker as running, or the host attests that no child was ever created
and the worker is recorded as stopped with no session. Ambiguous assignments,
generic cancellation text, unsettled claims, and claims lost to a restart stay
unresolved — blocking replacement, closure, and resume instead of being
guessed — and a fresh managed launch without an attributable worker is denied
before spawn. Assignment provenance identifies the current coordinator after a
session resumes; the task creator's historical session is not an execution
gate.

</details>

## Configuration and boundaries

Host setup stays in the selected platform's native configuration. The shared
MCP provider exposes the families present, keeps read-only inspection usable
without an attested caller, and returns `capability_unavailable` for mutations
from unattested callers.

Authority for Git, forge, YouTrack and documentation effects is the host's own
permission system plus the per-workspace
[autonomy grants](#autonomy-grants-per-workspace). A host deny always wins, and
Workit adds no consent prompts of its own: task pause/resume/close, worker
cancel and state import run without one, and `--confirm` on task families is
accepted and ignored. Missing credentials leave unrelated core work usable,
while an uncertain remote outcome blocks blind retry.

For routine authorized branch and commit work, use native host Git/shell tools
when managed coordination or outcome reconciliation is unnecessary. Inspect the
target checkout's conventions first; native permissions apply. There is no need
to start a Workit task just to commit, and a local commit does not require PR
readiness or task-closure paperwork. Never switch execution paths to evade a
denial or retry an uncertain effect. OpenCode uses native
host tools for mutations; Workit exposes read-only `workit_context` and shared
coordination tools. See the
[action reliability specification](docs/adaptive-workit/reliability-spec.md).
Newly assessed bounded behavior changes keep behavioral checks and self-review.
Security, data, public-contract and operational consequences, the thorough
preference, and explicit project requirements still require stronger review;
existing stored policies are not silently changed.

The task directory holds coordination state; it need not be a Git repository.
A metadata
lock whose owner is gone (dead or reused pid) is reclaimed by the next write.
A lock records its host plus, on Linux, its pid namespace and boot id; a lock
from another host, container namespace, boot, or an older Workit version cannot
be checked against this process table and is reclaimed only after a 10-minute
TTL (a lock from the same host and pid namespace but an earlier boot is
reclaimed at once). `workit doctor` warns when such an unverifiable lock has
blocked writes for over 30 s and prints `workit doctor --fix-lock --force --yes`. A write that meets a live holder retries briefly (250 ms inside host
plugins and the MCP server, 2 s in the CLI) and then returns the retryable
`busy` code, never `recovery_required`. `workit doctor` warns about a stale
lock and `workit doctor --fix-lock` clears it under the same reclaim guard
every write uses; `--force` (with `--yes` or an interactive confirmation) is the
explicit escape hatch for a lock whose owner cannot be verified.

Task state (3.0) lives in the git common directory, `.git/workit/` (shared by
every worktree of the repository and kept across worktree removal and `git
clean`), or in `<dir>/.workit/` outside git. Each task is an append-only event
log (`tasks/<id>/events.jsonl`, one structural patch per change) with a
rebuildable `snapshot.json`; there is no recovery directory, the log is the
history. A crash can only leave a torn last line, which readers ignore and the
next write truncates. Stored candidates are written once by content digest.
`workit gc` folds long logs into a checkpoint plus their 50 most recent events
(never losing the latest state), removes unreferenced blobs and stale temp
files, and only reports a 2.x `.workit/recovery/` left by migration until you
run `workit gc --prune-recovery --yes`; `--dry-run` writes nothing.

Every branch is one implicit task: the first note, check, ledger record or
commit on a branch creates it, and every task operation without a `taskId`
applies to it, so agents never manage ids. A detached HEAD is keyed by its
worktree and a non-git directory by its path. An explicit `task start` takes
the branch over; closing a task frees it. The first CLI command (or any
write) in a checkout with a 2.x `.workit/` store migrates it into the new
store, under the 2.x store's own lock (never while a 2.x process holds it),
keeps a backup under `legacy/`, and prints one line; host hooks never migrate
and say to run `workit task status`. `.workit/workspace.json` becomes a
marker, written into every checkout 3.0 writes for, that 2.x runtimes reject
with an upgrade message instead of starting a second store. Migrated tasks keep their ids and are not bound
to a branch: `workit task status --all` lists them and `workit task adopt <id>`
binds one. New branch
setup shows both the existing local base SHA and remote base SHA, rechecks
them, and creates only from that commit. Workit does
not reject Git-valid branch names or user commit
messages on formatting grounds. OS tasks can run from non-Git directories;
Git-only actions report unavailable when no checkout is selected.

Hosted merge rechecks the target immediately before the `gh`/`glab`
merge call. Those APIs condition on the PR/MR source SHA but do not support an
atomic target-branch condition, so a retarget after the recheck can still
redirect the merge.

`workit pr create` binds the pushed source SHA and verifies the provider PR head before reporting success. The provider create
APIs accept a branch name, so a concurrent push could still create a request
from a newer commit between the pre-check and the create call; that residual
non-atomic source-SHA race is accepted (decision `ae03c569`).

Examples:

- `context.read` with `{ "kind": "release", "range": "HEAD~1...HEAD" }`
- `workit youtrack note ABC-1 --markdown "..."`
- `workit changelog apply --entries '[{ "category": "Added", "text": "..." }]'`

OpenCode exposes the read-only `workit_context` tool with a flat payload.
Pi and the CLI expose the read-only `context.read` operation for `git`, `pr`, `youtrack`, `github_issue`, `gitlab_issue`,
`changelog`, `release`, and `affected` context. The tracker kinds return the
same title/body/state triple through authenticated `gh` and `glab` (GitLab
subgroups kept); they fail closed when the CLI is unavailable or not logged in.
Release context includes a deterministic Markdown
draft derived from the selected commits and changed files. Affected context
identifies documentation files; an actual edit uses the host's native editor or
`workit changelog apply`. Context reads require no approval and never change the checkout or Workit metadata. Cursor and Codex receive the
same contexts as read-only MCP resources under `workit://context/{kind}`; the
workspace always comes from the host-owned session context.

Candidate snapshots in Git workspaces use Git's ignore-aware file inventory, so
ignored dependency/build trees are not recursively scanned; non-Git folders
retain recursive inventory behavior.

### Autonomy grants (per workspace)

Grants live only in your workspace entry in `$HOME/.config/workit/workspaces.json`
(never in repository files). The `WORKFLOW_TOOLKIT_CONFIG`,
`WORKFLOW_TOOLKIT_CONFIG_DIR` and `XDG_CONFIG_HOME` overrides redirect the rest
of the config but never the grants: while one points elsewhere, grants resolve
to the defaults below.

```json
{ "name": "personal", "glob": "/home/you/projects/personal/**",
  "vcs": { "provider": "github", "account": "you" },
  "autonomy": { "push": true, "pr": true, "merge": "verified",
                "release": false, "rerun": true },
  "defaultEndpoint": "pr" }
```

When workspace globs overlap, Workit selects the match with the most literal
path components. Equally specific matches require an explicit workspace name.

- Defaults: `push`, `pr` and `rerun` are allowed; `merge` and `release` need an
  explicit grant. Without one the ceiling is: stack opened, CI green,
  independently verified ("verified, ready").
- `merge: "verified"` merges only with an accepted independent verdict;
  `merge: true` merges without one.
- `defaultEndpoint` (`commit` by default, or `pr`) is where an unnamed request
  stops; skills read it.
- `release` is reserved: no verb consumes it yet, so it is not enforced.
- Explicit grants require `vcs.account` for forge effects. Protected-branch
  pushes stay denied, and a host deny always wins.
- A legacy `autoApprove: true | [classes]` is read once as grants (the merge
  class becomes `merge: "verified"`, so a verdict is still required; branch and
  commit are dropped) and folded into
  `autonomy` on the next `workit grant` write.

Manage grants with `workit grant show|set|unset`. Raising a grant (or
`defaultEndpoint` from `commit` to `pr`) requires you at an interactive terminal
typing the workspace name to confirm; headless and agent shells (no TTY, or an
agent marker such as `CLAUDECODE`, `OPENCODE`, `CURSOR_AGENT`, `PI_CODING_AGENT`,
`AI_AGENT`, `AGENT` or any `CODEX_*` set) are refused with `blocked` and the
command to run yourself. Lowering is always allowed, and each write keeps
`workspaces.json.bak`.

This follows the D18 trust model: it stops an honest agent from raising its own
grants, not an adversarial one. A process that drives a pseudo-terminal, clears
the agent markers or edits `workspaces.json` directly can get past it. The hard
boundary is your host's permission prompt: deny or ask on `workit grant set` and
on edits under `~/.config/workit`.

Because grants are the real ceiling, allowlist only read verbs (for example
`workit pr status` and `workit grant show`) in host permission configs.

## Development

```bash
bun run build
bun run check
bun run test:acceptance
bun run verify:release-candidate
bun run validate:cursor-marketplace
```

Release qualification uses frozen CA/E fixtures (`test/acceptance/`), a generated
host capability matrix (`docs/workit-v1/capabilities.md`), and a stable gate that
blocks publication on missing deterministic or live evidence. The 90-run live batch
requires explicit authorization; see `docs/workit-v1/qualification.md`.

Published bundles are built with Bun and run on Node. The Cursor, OpenCode,
Codex, Pi, and Claude Code package builds copy the eleven canonical skills from `packages/workit-core`; no
host-specific skill forks are maintained.

## Repository layout

```text
workit/
├── packages/
│   ├── workit-core/        # shared core, skills, and contract template
│   ├── workit-mcp/         # shared MCP transport
│   ├── workit-opencode/    # OpenCode plugin
│   ├── workit-cursor/      # Cursor MCP, hooks, rule, and skills
│   ├── workit-codex/       # Codex CLI/desktop MCP, hooks, and skills
│   ├── workit-pi/          # Pi native extension, bundled core, and skills
│   ├── workit-claude-code/ # Claude Code plugin: hooks, agents, generated skills
│   └── workit-cli/         # CLI setup wizard
├── .cursor-plugin/         # Marketplace metadata
├── .claude-plugin/         # Claude Code marketplace (npm-sourced plugin entry)
└── test/                   # repository verification
```
