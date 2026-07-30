# Workflow Toolkit

Multi-platform Superpowers workflow plugin for **Cursor** and **OpenCode**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | repo root (`package.json`, `src/plugin.ts`) | 0.3.18 |
| **Cursor** | `cursor/` (MCP + hooks + rules + skills) | 0.3.18 |
| **Shared** | `scripts/`, `templates/` | — |

Config directory (both platforms): `~/.config/workflow-toolkit/`

## Getting started

Install once. After that, **Cursor auto-syncs on every new chat** and **OpenCode reloads from disk on every start** (live monorepo or `git pull` of the share clone). OpenCode does **not** auto-update npm/git pins from cache — we use a local live loader instead.

<details>
  <summary><strong>Cursor</strong> (full plugin + MCP + auto-update)</summary>

**1. Install once:**

```bash
curl -fsSL https://raw.githubusercontent.com/BrainerVirus/workflow-toolkit/main/scripts/install-cursor-plugin.sh | bash -s -- --github
```

Or from your monorepo clone:

```bash
./scripts/install-cursor-plugin.sh
```

**2. Fully quit Cursor IDE + Agent CLI, then reopen.**

**Auto-update:** each new Agent session runs `scripts/sync-runtime.sh` (≤20s). If `~/Documents/projects/personal/workflow-toolkit` exists, that tree is the source of truth; otherwise the share clone at `~/.local/share/workflow-toolkit` `git pull`s `main`.

**3. Optional — MCP button** (after step 1):

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=workflow-toolkit&config=eyJjb21tYW5kIjoiYmFzaCAtbGMgJ2V4ZWMgXCIkSE9NRS8ubG9jYWwvc2hhcmUvd29ya2Zsb3ctdG9vbGtpdC9zY3JpcHRzL3J1bi1jdXJzb3ItbWNwLnNoXCIgXCIkQFwiJyBfICR7d29ya3NwYWNlRm9sZGVyfSJ9)

> [!NOTE]
> The button adds the **MCP server** only. Slash skills (`/wf-commit`, …) come from the install script.

**Troubleshooting**

- Enable **Include third-party Plugins, Skills, and other configs**.
- Type `/wf-commit` in Agent chat.
- MCP code changes: toggle the MCP server off/on (long-lived process).

</details>

<details>
  <summary><strong>OpenCode</strong> (live loader — no bun cache pin)</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/BrainerVirus/workflow-toolkit/main/scripts/install-opencode-plugin.sh | bash
```

Or from a clone:

```bash
./scripts/install-opencode-plugin.sh
```

This writes `~/.config/opencode/plugins/workflow-toolkit.ts`, which syncs then imports `~/.local/share/workflow-toolkit/src/plugin.ts` on **every OpenCode start**. Repo edits (or `git pull` in the share) show up after restart — no cache clear, no version bump.

It also removes any `workflow-toolkit-opencode@github:…` / `file://…` pins from `opencode.json` so they cannot shadow the live loader.

Restart OpenCode. Prefer `opencode --auto` for permission auto-approve.

</details>

<details>
  <summary><strong>How auto-update works</strong></summary>

| | Cursor | OpenCode |
| --- | --- | --- |
| Trigger | `sessionStart` hook | Plugin load on process start |
| Source | Dev monorepo if present, else `git pull` share | Same sync, then live `import` |
| Share path | `~/.local/share/workflow-toolkit` | same |
| IDE package | copy → `~/.cursor/plugins/local/workflow-toolkit` | n/a |
| Manual sync | `./scripts/sync-runtime.sh` | same |

Dev path override: `WORKFLOW_TOOLKIT_DEV=/path/to/clone`.

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
