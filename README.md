# Workflow Toolkit

Multi-platform Superpowers workflow plugin: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | repo root (`package.json`, `src/plugin.ts`) | 0.3.18 |
| **Cursor** | `cursor/` (MCP + hooks + rules) | 0.3.18 |
| **Shared** | `scripts/`, `templates/`, `skills/` | — |

Config directory (both platforms): `~/.config/workflow-toolkit/`

## Install

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
"plugin": [
  "workflow-toolkit-opencode@git+file:///ABS/PATH/workflow-toolkit#v0.3.18"
]
```

The plugin auto-injects the workflow contract on every session via `experimental.chat.messages.transform` (same role as Cursor's `sessionStart` hook).

### Cursor

```bash
ln -sfn /ABS/PATH/workflow-toolkit/cursor ~/.cursor/plugins/local/workflow-toolkit
cd ~/.cursor/plugins/local/workflow-toolkit/mcp && npm install
```

Edit `cursor/mcp.json` if your clone path differs from the bundled absolute `command` path.

Reload Cursor. Session start injects hard gates + `templates/superpowers-doc-contract.md`.

## Architecture

```
User → platform skill (/wf-*) → workflow_* tool → shared shell script → agent formats output
```

- **OpenCode:** tools are native plugin tools (`src/tools/*`)
- **Cursor:** tools are MCP (`cursor/mcp/server.js`) calling the same `scripts/`
- **Handoff:** OpenCode seeds a new session with `execution-contract.md`; Cursor uses `workflow_handoff_prompt`

## Docs for OpenCode

Add Context7 MCP to `opencode.json` for live library docs (same idea as Cursor's context7 plugin):

```json
"context7": {
  "enabled": true,
  "type": "http",
  "url": "https://mcp.context7.com/mcp"
}
```

The injected workflow contract tells agents to prefer Context7 for API/library questions.

## Development

```bash
cd /path/to/workflow-toolkit
npx bun test          # OpenCode plugin tests
npx bun run typecheck
git tag v0.3.18       # bump package.json + cursor/.cursor-plugin/plugin.json together
```

## Future: Codex CLI

Add `codex/` with harness-specific adapter; keep `scripts/`, `templates/`, `skills/` shared at repo root.
