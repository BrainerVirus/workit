# @brainervirus/workit-cursor

Cursor plugin for workit — MCP server, session-start hook, rules, and skills for agentic coding workflows (specs, plans, YouTrack, CI-gated commits).

## Install

**Wizard (recommended)** — configures Cursor and/or OpenCode and installs the platform packages:

```bash
npx @brainervirus/workit-cli init
```

**npm (package)** — the package is published as `@brainervirus/workit-cursor`; its `.cursor-plugin/plugin.json` identifies the plugin as `workit` (display name `Workit`) and registers its MCP server, hook, rules, and skills. A local (non-npm) install lives at `~/.cursor/plugins/local/workit` and writes `enabled_plugins.workit = true`; the installer migrates exact legacy `workflow-toolkit` entries only after the replacement succeeds.

**Marketplace** — see [Marketplace](#marketplace).

**Manual** — add the MCP server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "workit": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@brainervirus/workit-cursor@0.8.0",
        "workit-cursor-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Requirements

- **Node.js ≥ 22** — the MCP server and session-start hook are self-contained Node bundles invoked through `npx`.
- **Network** — `npx -y …@0.8.0` resolves and downloads the package on first run in each environment; a machine that cannot reach the npm registry cannot start the MCP server or hook (see [Runtime](#runtime)).

## What it provides

- MCP server exposing the `workflow_*` tools (branch setup, PR create/context, docs validate/promote, YouTrack post/log/time, templates, rules, presentation, doctor, handoff, and plan lifecycle `workflow_plan_pause`/`resume`/`complete`).
- Session-start contract hook.
- 4 rules and 12 `wk-*` skills (plus 14 sanitized Superpowers skills).

## Host limitations

Cursor adapts workit through policy-only confirmation: approvals and lifecycle transitions are recorded as policy decisions (`attested: false`) rather than fabricated delegated identity, and subagent-driven plan execution is not supported on this host. Approvals bind to the document's exact SHA-256 digest — editing an approved spec/plan invalidates the approval and forces a fresh reapproval. OpenCode records native `question` receipts and runs delegated tasks; see the root [README](../../README.md#host-capabilities) for the full host-capability matrix.

## Configuration

- Plugin metadata: `packages/workit-cursor/.cursor-plugin/plugin.json` (`name: "workit"`, `displayName: "Workit"`).
- MCP server: `mcp.json`.
- Session-start hook: `hooks/hooks-cursor.json`.
- Rules: `rules/` (`ask-question-only.mdc`, `cursor-todowrite.mdc`, `no-worktrees.mdc`, `sdd-docs-path.mdc`).
- Skills: `skills/` (12 `wk-*`) and `vendor/superpowers/skills/` (14).

## Runtime

Cursor launches the MCP server and session-start hook through `npx`, so the shipped manifests contain no repository-relative `dist` paths:

- **MCP server** — `npx -y --package=@brainervirus/workit-cursor@0.8.0 workit-cursor-mcp ${workspaceFolder}`. It speaks the MCP stdio protocol; `stdout` is reserved for protocol messages and diagnostics go to `stderr`.
- **Session-start hook** — `npx -y --package=@brainervirus/workit-cursor@0.8.0 workit-cursor-session-start`. It emits valid hook output and a diagnostic on runtime failure, and remains fail-open where Cursor's hook contract requires startup continuity.
- `npx` startup or network failure is surfaced by Cursor as an MCP/hook startup failure; Workit never silently substitutes stale local runtime code.

The runtime runs from the exact reviewed pin `@0.8.0`: Cursor reviews plugin metadata from Git, while npm serves the pinned runtime. Bumping the pin is a deliberate reviewed update, made only after the target npm version is public — never a mutable `latest` dist-tag. See [Update review](#update-review).

## Security and data handling

- **Secrets** — tokens are stored in files with mode 600 (`~/.config/workit/*.token`) and are never printed by tools; edit them locally.
- **Logs** — a persistent JSONL journal records redacted structured diagnostics under the configuration directory; Cursor keeps `stderr` diagnostics for protocol safety, and `stdout` remains reserved for the MCP/hook protocol (the logger never writes to it).
- **External interactions** — Git/VCS (branch resolution, PR/MR creation) and YouTrack (task updates, time logging) happen only when you invoke the corresponding tools; local setup copies files under `~/.cursor/plugins/local/workit` and `~/.config/workit/`.

## Plugin layout

| Path | Contents |
| --- | --- |
| `mcp/` + `dist/mcp-server.js` | MCP server entry (built). |
| `hooks/` | session-start hook manifest. |
| `rules/` | 4 `.mdc` rules. |
| `skills/` | 12 `wk-*` skills. |
| `vendor/superpowers/skills/` | 14 sanitized Superpowers skills. |
| `.cursor-plugin/plugin.json` | authoritative plugin manifest. |

## Package scripts

```bash
bun run build   # bundle dist/mcp-server.js, dist/cursor-session-start.js, sanitize vendor skills
```

From the repository root, `bun run validate:cursor-marketplace` validates the tracked Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).

## Marketplace

The repository root carries `.cursor-plugin/marketplace.json`, indexing `packages/workit-cursor` (plugin `workit` / `Workit`). Cursor installs Marketplace plugins from Git and does not build the repository, so all declared skills, rules, and assets are tracked and validated in CI — the runtime is launched from npm as described in [Runtime](#runtime).

- **Installing from Marketplace** — a Marketplace admin adds the repository URL through Cursor's authenticated publisher flow; end users then install the plugin from the Cursor Marketplace UI, which reads `.cursor-plugin/plugin.json` and the tracked components directly from Git.
- **Submission** — Marketplace submission is a separate, later authenticated action at `https://cursor.com/marketplace/publish`. It is **not** performed here and no publication or acceptance is claimed; the repository is kept validated and submission-ready.
- **Update review** — Git plugin metadata (manifest, rules, skills, assets) is reviewed by Cursor on Marketplace updates, while the npm runtime is pinned to the exact reviewed `@0.8.0`. Bumping that pin in `mcp.json` / `hooks-cursor.json` is a deliberate reviewed change: only after the target npm version is public, never a mutable `latest` dist-tag.
- **Troubleshooting** — `workit doctor` (or the `workflow_doctor` tool) reports installation health including runtime, token, VCS/YouTrack, and log-writability checks; it exits nonzero on failure. An MCP/hook startup failure with no network is an `npx`/registry reachability issue, not a Workit defect.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
