# Workit

Multi-platform Workit workflow support for Cursor, OpenCode, Codex CLI/desktop,
Pi, and the CLI. The
hosts share one task contract and eight operation families while adapting
authority and lifecycle behavior to the native surfaces each host documents.

| Package     | Purpose                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| OpenCode    | Native plugin with seven method skills, eight tools, and provider-safe schemas |
| Cursor      | MCP transport, one native hook dispatcher, one contract rule, and seven skills  |
| Codex       | Native plugin manifest, shared MCP transport, and documented lifecycle hooks     |
| Pi          | Native npm extension with eight tools, seven skills, and session continuity      |
| Shared MCP  | Low-level transport for the eight core operation families                       |
| Shared core | Task, policy, evidence, finding, decision, worker, writer, and continuity state |
| CLI         | Setup wizard (`workit`)                                                         |

## Install

The wizard configures the selected host packages and project files:

```bash
npx @brainervirus/workit-cli init
```

Published artifacts require Node.js 24 or newer. Bun 1.4.1 is used only for
development, builds, and tests. Local development starts with:

```bash
bun i
```

## What it provides

- Eight shared `workit_*` operation families: task, policy, evidence, finding,
  decision, worker, writer, and state.
- Seven canonical method skills: behavioral TDD, challenge, debug, handoff,
  implement, plan, and review.
- A `<workit-contract>` bootstrap marker carrying shared invariants.
- Host-native capability reporting that never fabricates authority, receipts,
  delegation tokens, or cross-process identity.

Cursor uses the shared MCP transport and one bounded native hook executable.
AskQuestion is policy-only (`agent_guided`); session start and compaction are
non-blocking; arbitrary shell writes, Tab edits, and stable subagent-stop
identity are unavailable. Reviewer and investigator native delegation is
read-only. Implementer delegation is unavailable because Cursor cannot attest
writer identity or safely release a child writer.

Codex CLI and desktop use the same shared transport and native hook bundle;
their surface qualification remains separate. Codex hooks provide bounded
known-write guardrails and read-only/agent-guided subagent observations, but no
native arbitrary-question receipt or attested writer delegation.

Pi loads `@brainervirus/workit-pi` through its native package manager and reads
the package's `pi.extensions` and `pi.skills` manifest entries. The extension
uses Pi's native session identity, confirmation UI, and known write/edit tool
boundary with the shared core. Headless required decisions return
`needs_input`; arbitrary shell writes remain agent-guided because Pi extensions
are not an OS sandbox. Its bundled coordinator can launch fresh stock-Pi
reviewer/investigator processes and explicitly scoped implementers; writer
ownership is acquired only after native process observation, and cancellation
timeouts remain uncertain until an exit is observed.
Pi also exposes one child-disabled `workit_worker_control` host-orchestration
tool for launch/cancel/reconcile; the shared core surface remains exactly eight
`workit_*` operation tools.

## Manual setup

OpenCode loads the package from its plugin configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brainervirus/workit-opencode"]
}
```

Pi package discovery uses the stock package manager (local development example):

```bash
pi install ./packages/workit-pi -l --approve
```

The packaged runtime is self-contained apart from its Pi `^0.85.1` peer and
requires Node.js 24 or newer.

Cursor's plugin manifest registers the MCP server, hook manifest, one contract
rule, and seven skills. For a direct MCP entry, use the package's published
launcher:

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

The `@latest` selector and `--prefer-online` flag are intentional: the runtime
is resolved from npm at launch and does not depend on a checkout-local `dist/`.
Marketplace metadata is tracked under `.cursor-plugin/` and remains
submission-ready without claiming publication or acceptance.

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

Examples include `context.read` with `{ "kind": "release", "range": "HEAD~1...HEAD" }`,
comment-only `youtrack.update` with `{ "issueId": "ABC-1", "markdown": "..." }`,
and `changelog.apply` with `{ "entries": [{ "category": "Added", "text": "..." }] }`.

All native adapters and the CLI also expose the read-only `context.read`
operation for `git`, `pr`, `youtrack`, `changelog`, `release`, and `affected`
context. Release context includes a deterministic Markdown draft derived from
the selected commits and changed files. Affected context identifies documentation
files; an actual edit still uses the existing native editor (for example
`changelog.apply`) with writer/scope checks and host-observed evidence. The CLI
can identify affected files but does not claim to edit them without its native
action route. Context reads require no approval or writer and never change the
checkout or Workit metadata. Cursor and Codex receive the same contexts as
read-only MCP resources under `workit://context/{kind}`; the workspace always
comes from the host-owned session context.

Cursor ships only `rules/workit-contract.mdc`. That rule documents the shared
contract, exact workspace/session scope, read-only native delegation, and the
surfaces Cursor cannot attest or block.

## Development

```bash
bun run build
bun run check
bun run verify:release-candidate
bun run validate:cursor-marketplace
```

Published bundles are built with Bun and run on Node. The Cursor and OpenCode
package builds copy the seven canonical skills from `packages/workit-core`; no
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
