# Workflow Toolkit

Multi-platform Superpowers workflow plugin: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

**Repo:** `~/Documents/projects/personal/workflow-toolkit`

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | repo root (`package.json`, `src/plugin.ts`) | 0.3.18 |
| **Cursor** | `cursor/` (MCP + hooks + rules) | 0.3.18 |
| **Shared** | `scripts/`, `templates/` | — |
| **Skills** | `skills/` (OpenCode) + `cursor/skills/` (Cursor) | platform-specific |

Config directory (both platforms): `~/.config/workflow-toolkit/`

## Repo layout

```
workflow-toolkit/
├── src/              # OpenCode plugin (TypeScript)
├── scripts/          # shared shell/python
├── templates/        # execution + superpowers contracts
├── skills/           # OpenCode-native skills
├── cursor/           # Cursor plugin (MCP, hooks, rules)
├── .github/workflows/ci.yml
└── test/             # bun tests (OpenCode plugin)
```

## Install

### OpenCode

`~/.config/opencode/opencode.json`:

```json
"plugin": [
  "workflow-toolkit-opencode@git+file:///home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit#v0.3.18"
]
```

After GitHub remote:

```json
"workflow-toolkit-opencode@github:YOUR_USER/workflow-toolkit#v0.3.18"
```

Session bootstrap + `workflow_present_*` tools ship in v0.3.18+. Use `opencode --auto` (see `~/.zshrc` wrapper) for permission auto-approve.

### Cursor

```bash
ln -sfn ~/Documents/projects/personal/workflow-toolkit/cursor ~/.cursor/plugins/local/workflow-toolkit
cd ~/.cursor/plugins/local/workflow-toolkit/mcp && npm install
```

Reload Cursor.

## CI / local checks

```bash
cd ~/Documents/projects/personal/workflow-toolkit
bun run check    # bun test + tsc + cursor MCP regressions
```

GitHub Actions runs the same on push/PR to `main`.

## Publish to GitHub

```bash
cd ~/Documents/projects/personal/workflow-toolkit
gh auth login
gh repo create workflow-toolkit --private --source=. --remote=origin
git push -u origin main --tags
```

## Architecture

| Concern | OpenCode | Cursor |
| --- | --- | --- |
| Tools | native plugin | MCP server |
| Session contract | messages.transform | sessionStart hook |
| Handoff | spawns OpenCode session | handoff prompt |
| Shared logic | `scripts/` | `scripts/` via `PLUGIN_ROOT` |

## Future: Codex CLI

Add `codex/` adapter; reuse `scripts/` and `templates/`.
