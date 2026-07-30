# Workflow Toolkit

Multi-platform Superpowers workflow plugin for **Cursor** and **OpenCode**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | repo root (`package.json`, `src/plugin.ts`) | 0.3.18 |
| **Cursor** | `cursor/` (MCP + hooks + rules + skills) | 0.3.18 |
| **Shared** | `scripts/`, `templates/` | — |

Config directory (both platforms): `~/.config/workflow-toolkit/`

## Getting started

Install once per machine. Cursor needs the full plugin (skills `/wf-*`, hooks, rules, MCP). OpenCode loads the TypeScript plugin from GitHub.

<details>
  <summary><strong>Cursor</strong> (full plugin + MCP)</summary>

**1. Install the plugin** (skills, hooks, rules, MCP):

```bash
curl -fsSL https://raw.githubusercontent.com/BrainerVirus/workflow-toolkit/main/scripts/install-cursor-plugin.sh | bash -s -- --github
```

Or from a local clone:

```bash
./scripts/install-cursor-plugin.sh
```

This syncs to `~/.local/share/workflow-toolkit` and copies the Cursor package into `~/.cursor/plugins/local/workflow-toolkit` (real directory — symlinks break IDE discovery).

**2. Fully quit Cursor IDE + Agent CLI, then reopen.**

**3. Optional — MCP only via Cursor button** (after step 1):

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=workflow-toolkit&config=eyJjb21tYW5kIjoiYmFzaCAtbGMgJ2V4ZWMgXCIkSE9NRS8ubG9jYWwvc2hhcmUvd29ya2Zsb3ctdG9vbGtpdC9zY3JpcHRzL3J1bi1jdXJzb3ItbWNwLnNoXCIgXCIkQFwiJyBfICR7d29ya3NwYWNlRm9sZGVyfSJ9)

> [!NOTE]
> The button adds the **MCP server** only. Slash skills (`/wf-commit`, `/wf-pr`, …) come from the install script in step 1.

**Or MCP manually:** Cursor Settings → MCP → New MCP Server:

```json
{
  "mcpServers": {
    "workflow-toolkit": {
      "command": "bash",
      "args": [
        "-lc",
        "exec \"$HOME/.local/share/workflow-toolkit/scripts/run-cursor-mcp.sh\" \"$0\"",
        "${workspaceFolder}"
      ]
    }
  }
}
```

**Troubleshooting**

- Enable **Include third-party Plugins, Skills, and other configs**.
- Plugin shows as **Workflow Toolkit**; type `/wf-commit` in Agent chat.
- After pulling monorepo changes, re-run `./scripts/install-cursor-plugin.sh`.

</details>

<details>
  <summary><strong>OpenCode</strong></summary>

**One-liner** (pins GitHub tag in `~/.config/opencode/opencode.json`):

```bash
curl -fsSL https://raw.githubusercontent.com/BrainerVirus/workflow-toolkit/main/scripts/install-opencode-plugin.sh | bash -s -- v0.3.18
```

Or from a clone:

```bash
./scripts/install-opencode-plugin.sh v0.3.18
```

**Manual pin:**

```json
{
  "plugin": [
    "workflow-toolkit-opencode@github:BrainerVirus/workflow-toolkit#v0.3.18"
  ]
}
```

Local file pin (dev):

```json
"workflow-toolkit-opencode@git+file:///path/to/workflow-toolkit#v0.3.18"
```

Restart OpenCode / start a new session. Prefer `opencode --auto` for permission auto-approve.

</details>

## Repo layout

```
workflow-toolkit/
├── src/                 # OpenCode plugin (TypeScript)
├── scripts/             # shared shell/python + installers
├── templates/           # execution + superpowers contracts
├── skills/              # OpenCode-native skills
├── cursor/              # Cursor plugin (MCP, hooks, rules, skills)
├── .github/workflows/   # CI + release
└── test/                # bun tests (OpenCode plugin)
```

## CI / local checks

```bash
bun run check    # bun test + tsc + cursor MCP regressions
```

GitHub Actions:

- **CI** — on push/PR to `main` (`actions/checkout@v7`, `actions/setup-node@v7`, `oven-sh/setup-bun@v2`)
- **Release** — on tag `v*`: same checks, then `softprops/action-gh-release@v3`

```bash
git tag v0.3.19
git push origin v0.3.19
```

## Architecture

| Concern | OpenCode | Cursor |
| --- | --- | --- |
| Tools | native plugin | MCP server |
| Session contract | `messages.transform` | `sessionStart` hook |
| Handoff | spawns OpenCode session | handoff prompt |
| Shared logic | `scripts/` | `scripts/` via `WORKFLOW_TOOLKIT_ROOT` |
| Install root | GitHub plugin pin | `~/.local/share/workflow-toolkit` + local plugin copy |

## Future: Codex CLI

Add `codex/` adapter; reuse `scripts/` and `templates/`.
