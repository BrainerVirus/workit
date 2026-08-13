# @brainervirus/workit-cursor

Cursor plugin for workit — MCP server, session-start hook, rules, and skills for agentic coding workflows (specs, plans, YouTrack, CI-gated commits).

## Install

**Wizard (recommended)** — configures Cursor and/or OpenCode and installs the platform packages:

```bash
npx @brainervirus/workit-cli init
```

**npm / Marketplace** — the package is published as `@brainervirus/workit-cursor`; its `.cursor-plugin/plugin.json` identifies the plugin as `workit` (display name `Workit`) and registers its MCP server, hook, rules, and skills. A local (non-npm) install lives at `~/.cursor/plugins/local/workit` and writes `enabled_plugins.workit = true`; the installer migrates exact legacy `workflow-toolkit` entries only after the replacement succeeds.

**Manual** — add the MCP server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "workit": {
      "command": "node",
      "args": [
        "./node_modules/@brainervirus/workit-cursor/dist/mcp-server.js",
        "${workspaceFolder}"
      ]
    }
  }
}
```

Requirements: Node ≥ 20.

## What it provides

- MCP server exposing the `workflow_*` tools (branch setup, PR create/context, docs validate/promote, YouTrack post/log/time, templates, rules, presentation, doctor, handoff).
- Session-start contract hook.
- 4 canonical rules and 12 `wk-*` skills (plus 14 sanitized Superpowers skills).

## Host limitations

Cursor adapts workit through policy-only confirmation: approvals and commits are recorded as policy decisions (`attested: false`) rather than fabricated delegated identity, and subagent-driven plan execution is not supported on this host. OpenCode records native `question` receipts and runs delegated tasks; see the root [README](../../README.md#host-capabilities) for the full host-capability matrix.

## Configuration

- Plugin metadata: `packages/workit-cursor/.cursor-plugin/plugin.json` (`name: "workit"`, `displayName: "Workit"`).
- MCP server: `mcp.json`.
- Session-start hook: `hooks/hooks-cursor.json`.
- Rules: `rules/` (`ask-question-only.mdc`, `cursor-todowrite.mdc`, `no-worktrees.mdc`, `sdd-docs-path.mdc`).
- Skills: `skills/` (12 `wk-*`) and `vendor/superpowers/skills/` (14).

## Security and data handling

- **Secrets** — tokens are stored in files with mode 600 and are never printed by tools; edit them locally.
- **Logs** — a persistent JSONL journal records redacted structured diagnostics; Cursor keeps `stderr` diagnostics for protocol safety, and `stdout` remains reserved for the MCP/hook protocol (the logger never writes to it).
- **External interactions** — Git/VCS (branch resolution, PR/MR creation) and YouTrack (task updates, time logging) happen only when you invoke the corresponding tools; local setup copies files under `~/.cursor/plugins/local/workit`.

## Plugin layout

| Path | Contents |
| --- | --- |
| `mcp/` + `dist/mcp-server.js` | MCP server entry (built). |
| `hooks/` | session-start hook manifest. |
| `rules/` | 4 canonical `.mdc` rules. |
| `skills/` | 12 `wk-*` skills. |
| `vendor/superpowers/skills/` | 14 sanitized Superpowers skills. |
| `.cursor-plugin/plugin.json` | authoritative plugin manifest. |

## Package scripts

```bash
bun run build   # bundle dist/mcp-server.js, dist/cursor-session-start.js, sanitize vendor skills
```

## Marketplace

The package ships Cursor plugin metadata (`workit` / `Workit`). Marketplace submission is a separate, later authenticated action after the corrected npm packages are public; see the repository [CHANGELOG](../../CHANGELOG.md) and root [README](../../README.md#versioning) for release state.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
