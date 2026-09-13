# Workit

Multi-platform Workit workflow support for Cursor, OpenCode, Codex CLI/desktop,
Pi, and the CLI. The hosts share one task contract and eight operation families
while adapting authority and lifecycle behavior to the native surfaces each
host documents.

| Package     | Purpose                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| OpenCode    | Native plugin with fourteen method skills, eight tools, and provider-safe schemas |
| Cursor      | MCP transport, one native hook dispatcher, one contract rule, and fourteen skills  |
| Codex       | Native plugin manifest, shared MCP transport, documented lifecycle hooks, and fourteen skills |
| Pi          | Native npm extension with eight tools, fourteen skills, and session continuity      |
| Shared MCP  | Low-level transport for the eight core operation families                       |
| Shared core | Task, policy, evidence, finding, decision, worker, writer, and continuity state |
| CLI         | Setup wizard (`workit`)                                                         |

## Install

Requires **Node.js 24 or newer**. The wizard detects your hosts, configures the
ones you pick, and writes your global config and optional project files:

```bash
npx @brainervirus/workit-cli init
```

`workit init` is an interactive TTY wizard (locale, timezone, branch policy,
YouTrack, VCS, workspaces, project hygiene). `workit doctor` verifies any
install. Project setup defaults to No: press `n` to skip adding files when
configuring from a parent folder containing multiple repositories. Press `y`
only to add hygiene files and gitignore entries to the displayed directory.
Re-running init preserves existing credentials and files; it does not remove
templates created by an earlier install. Locale and timezone selectors keep
the current selection until you choose another value.

Manual setup per tool:

<details>
<summary><strong>OpenCode</strong> — native plugin</summary>

Run the wizard and select OpenCode, or add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brainervirus/workit-opencode"]
}
```

`workit init` writes that same npm package pin for published installs. A
checkout/dev install may pin `file://…/packages/workit-opencode/…` instead.
Do not pin into pnpm dlx or `_npx` cache paths — those break when the cache is
cleared.

Requires OpenCode 1.18.30 and Node.js 24+. The published plugin is a
self-contained Node bundle (no runtime `@opencode-ai/plugin` dependency) and
ships the eight native tools plus the fourteen method skills.

</details>

<details>
<summary><strong>Cursor</strong> — plugin, MCP transport, and hooks</summary>

Run the wizard and select Cursor: it registers the plugin, the MCP server, the
session hook, the contract rule, and the fourteen skills.

Or add the published launcher to the Cursor MCP config:

```json
{
  "mcpServers": {
    "workit": {
      "command": "npx",
      "args": [
        "-y",
        "--prefer-online",
        "--package=@brainervirus/workit-cursor@latest",
        "workit-cursor-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

`@latest` plus `--prefer-online` are intentional: the runtime resolves from npm
at launch and never depends on a checkout-local `dist/`. The wizard also copies
the plugin into `~/.cursor/plugins/local/workit` as a **real directory** (not a
symlink into pnpm dlx/`_npx` caches). Requires Node.js 24+ and network access on
first run. Plugin metadata lives under `.cursor-plugin/` and is
submission-ready for the Cursor Marketplace; it is not published there.

</details>

<details>
<summary><strong>Codex CLI / desktop</strong> — plugin manifest and shared MCP</summary>

Register the plugin manifest and hooks per the Codex docs, pointing the
launchers at this package:

```bash
workit-codex-mcp    # shared-transport MCP server (reads)
workit-codex-hook   # SessionStart / PreToolUse / subagent hooks
```

Reads run over MCP; mutations run CLI-driven because caller-unattested MCP
cannot attest effects:

```bash
node_modules/.bin/workit <family> <action> --json --confirm
workit writer acquire --actor <session-id>   # bind a writer to this session
```

Requires Node.js 24+ and Codex CLI or desktop. The hook honors exactly the
bound session and nothing else.

</details>

<details>
<summary><strong>Pi</strong> — native extension</summary>

Install the package alongside the Pi peer dependency (Pi 0.85.1):

```bash
pi install @brainervirus/workit-pi             # published package
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
workit init              # interactive setup wizard
workit doctor            # offline installation health report (--json for machines)
workit <family> <action> [--payload <json|@file|->] [--task <id>] [--confirm] [--json]
workit action <operation> --payload <JSON> [--preview] [--confirm] [--json]
workit handoff --task <id> [--json]
workit uninstall         # remove host registrations (keeps ~/.config/workit)
```

The packed CLI is a self-contained Node bundle; Node.js 24+ is required.

</details>

<details>
<summary><strong>Upgrading a legacy install</strong></summary>

`workit doctor` reports `stale_install` when a legacy selector or a
local-dist install is behind the current runtime, or when OpenCode's
frozen `@latest` package cache lags published `workit-opencode`, with the
exact repair step; Cursor canonical `@latest` installs never fail on
version metadata.

```bash
workit cutover preview [--hosts <hosts>] [--json]
workit cutover apply   [--hosts <hosts>] [--resolution k=v] [--confirm]
workit cutover rollback preview|apply <backupId> [--json] [--confirm]
```

</details>

## What it provides

- Eight shared `workit_*` operation families: task, policy, evidence, finding,
  decision, worker, writer, and state.
- Fourteen canonical method skills: behavioral TDD, challenge, debug, handoff,
  implement, plan, review, babysit, blast-radius, deslop (policy-gated before
  pull requests), diagram, mockup, green-run, and steer.
- A `<workit-contract>` bootstrap marker carrying shared invariants.
- Host-native capability reporting that never fabricates authority, receipts,
  delegation tokens, or cross-process identity.

Skills are reachable two ways: model-invoked automatically when the task fits,
or explicitly via five bare aliases — `/challenge`, `/babysit`, `/implement`,
`/plan`, `/debug` — on OpenCode, Cursor, and Pi. An alias routes through
policy to the method skills and never calls another alias. Codex CLI has no
slash path: invoke skills explicitly as `$workit-<name>` or from the `/skills`
picker.

## Host surfaces

Each adapter maps the shared contract to what the host can actually attest.

<details>
<summary><strong>Cursor</strong></summary>

Cursor uses the shared MCP transport and one bounded native hook executable.
AskQuestion is policy-only (`agent_guided`); session start and compaction are
non-blocking; arbitrary shell writes, Tab edits, and stable subagent-stop
identity are unavailable. Reviewer and investigator native delegation is
read-only. Implementer delegation is unavailable because Cursor cannot attest
writer identity or safely release a child writer. Cursor ships only
`rules/workit-contract.mdc`, which documents the shared contract, exact
workspace/session scope, read-only native delegation, and the surfaces Cursor
cannot attest or block.

</details>

<details>
<summary><strong>Codex CLI / desktop</strong></summary>

Codex CLI and desktop use the same shared transport and native hook bundle;
their surface qualification remains separate. Codex hooks provide bounded
known-write guardrails and read-only/agent-guided subagent observations, but no
native arbitrary-question receipt or attested writer delegation.

</details>

<details>
<summary><strong>Pi</strong></summary>

Pi loads `@brainervirus/workit-pi` through its native package manager and reads
the package's `pi.extensions` and `pi.skills` manifest entries. The extension
uses Pi's native session identity, confirmation UI, and known write/edit tool
boundary with the shared core. Headless required decisions return
`needs_input`; arbitrary shell writes remain agent-guided because Pi extensions
are not an OS sandbox. Its bundled coordinator can launch fresh stock-Pi
reviewer/investigator processes and explicitly scoped implementers; writer
ownership is acquired only after native process observation, and cancellation
timeouts remain uncertain until an exit is observed. Pi also exposes one
child-disabled `workit_worker_control` host-orchestration tool for
launch/cancel/reconcile; the shared core surface remains the eight `workit_*`
operation families (the orchestration tool is adapter-owned, not a ninth
family).

</details>

<details>
<summary><strong>Worker dispatch</strong></summary>

Hosts that can observe their own launch surface claim a worker's launch slot
before spawning it, through the host-only core methods
`prepareWorkerDispatch` and `commitWorkerDispatch`. The reservation lives in
the adapter process, is never serialized, and settles exactly once: either the
observed child session binds the worker as running, or the host attests that no
child was ever created and the worker is recorded as stopped with no session. A
cancelled launch is only resolved this way when the same reservation proves it;
ambiguous assignments, generic cancellation text, and reservations lost to a
restart stay unresolved rather than being guessed.

</details>

## Configuration and boundaries

Host setup stays in the selected platform's native configuration. The shared
MCP provider keeps read-only inspection usable without an attested caller and
returns `capability_unavailable` for authority-sensitive mutations when the
host cannot prove the caller boundary.

Optional Git, hosting, YouTrack, and documentation effects use one-time
approved action reservations and host-observed settlement on the existing
host-owned effect surfaces. A concrete call must match the exact canonical
operation/target/payload approved by the native host; prose or substring
matches never authorize it. Missing credentials leave unrelated core work
usable, while an uncertain remote outcome blocks blind retry. OpenCode and Pi
use native approval receipts; the CLI `workit action` route shows the exact
descriptor and requires an interactive TTY confirmation. A headless CLI call
(including `--confirm` without a TTY) returns `needs_input`, while the
caller-unattested MCP surface keeps optional mutations unavailable. Time
entries require a duration supplied or confirmed by the user.

Examples:

- `context.read` with `{ "kind": "release", "range": "HEAD~1...HEAD" }`
- comment-only `youtrack.update` with `{ "issueId": "ABC-1", "markdown": "..." }`
- `changelog.apply` with `{ "entries": [{ "category": "Added", "text": "..." }] }`

All native adapters and the CLI also expose the read-only `context.read`
operation for `git`, `pr`, `youtrack`, `github_issue`, `gitlab_issue`,
`changelog`, `release`, and `affected` context. The tracker kinds return the
same title/body/state triple; GitHub reuses the vcs token with `gh` issue-ref
parsing and GitLab resolves the full project path (subgroups kept), both
fail-closed without a token. Release context includes a deterministic Markdown
draft derived from the selected commits and changed files. Affected context
identifies documentation files; an actual edit still uses the existing native
editor (for example `changelog.apply`) with writer checks and host-observed
evidence. The CLI can identify affected files but does not claim to edit them
without its native action route. Context reads require no approval or writer
and never change the checkout or Workit metadata. Cursor and Codex receive the
same contexts as read-only MCP resources under `workit://context/{kind}`; the
workspace always comes from the host-owned session context.

Candidate snapshots in Git workspaces use Git's ignore-aware file inventory, so
ignored dependency/build trees are not recursively scanned; non-Git folders
retain recursive inventory behavior.

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
Codex, and Pi package builds copy the fourteen canonical skills from `packages/workit-core`; no
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
│   └── workit-cli/         # CLI setup wizard
├── .cursor-plugin/         # Marketplace metadata
└── test/                   # repository verification
```
