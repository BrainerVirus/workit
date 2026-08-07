# Workflow Toolkit

Multi-platform Superpowers workflow plugin for **Cursor** and **OpenCode**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | repo root (`package.json`, `src/plugin.ts`) | 0.4.0 |
| **Cursor** | `cursor/` (MCP + hooks + rules + skills) | 0.4.0 |
| **Shared** | `scripts/`, `templates/` | — |

Config directory (both platforms): `~/.config/workflow-toolkit/`

[![npm version](https://img.shields.io/npm/v/flowkit)](https://www.npmjs.com/package/flowkit)
[![CI](https://img.shields.io/github/actions/workflow/status/BrainerVirus/workflow-toolkit/ci.yml?branch=main&label=CI)](https://github.com/BrainerVirus/workflow-toolkit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

**Consumers** — the plugin is published to npm as `flowkit`:

```bash
npm i flowkit
```

**Local development** — use the repo path instead; no package cache, disk is the source of truth:

```bash
bun i
```

## Usage

**OpenCode** — reference the plugin entry in `opencode.json` / `opencode.jsonc` (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["flowkit"]
}
```

Local dev variant (absolute path to this repo):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/workflow-toolkit/src/plugin.ts"]
}
```

**Cursor** — the MCP server runs from the package's `cursor/` directory. Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "flowkit": {
      "command": "bun",
      "args": ["run", "node_modules/flowkit/cursor/mcp/server.ts"]
    }
  }
}
```

Local dev variant: point `WORKFLOW_TOOLKIT_ROOT` at this repo (the MCP launcher `scripts/run-cursor-mcp.sh` resolves it), or run the install script from the repo.

## Requirements

- **Bun ≥ 1.0** — runtime for the shared `src/core` logic, the OpenCode plugin, and the Cursor MCP server (`bun server.ts`). Install once:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then add to your shell profile (or rely on the MCP launcher's `~/.bun/bin/bun` fallback):

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

- **Git** — branch resolution, SDD review diffs, and verify gates.
- (Optional) **Python 3** — required only for `workflow_changelog_apply` (runs `scripts/changelog/apply-unreleased.py`). Everything else is pure TS via bun.

## Getting started

Install once. After that, **Cursor auto-syncs on every new chat** and **OpenCode syncs via your `opencode()` shell wrapper**, then loads the plugin from disk with `file://…/src/plugin.ts` (no stuck bun cache).

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
  <summary><strong>OpenCode</strong> (file:// load + sync on launch)</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/BrainerVirus/workflow-toolkit/main/scripts/install-opencode-plugin.sh | bash
```

Or from a clone:

```bash
./scripts/install-opencode-plugin.sh
```

This pins OpenCode to:

```json
"file:///HOME/.local/share/workflow-toolkit/src/plugin.ts"
```

That loads the plugin **directly from disk** (no bun package cache). Your `~/.zshrc` `opencode()` wrapper runs `sync-runtime.sh` before each launch so the share tree matches the monorepo.

Restart OpenCode (new shell so `.zshrc` reloads), then type `/wf-commit`.

</details>

<details>
  <summary><strong>How auto-update works</strong></summary>

| | Cursor | OpenCode |
| --- | --- | --- |
| Trigger | `sessionStart` hook | `opencode()` wrapper sync, then start |
| Source | Dev monorepo if present, else `git pull` share | Same |
| Share path | `~/.local/share/workflow-toolkit` | same |
| Load mechanism | copy → `~/.cursor/plugins/local/…` | `file://…/src/plugin.ts` in `opencode.json` |
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

- **CI** — on push/PR to `main`: matrix of 3 OS (ubuntu, macos, windows) running `actions/checkout@v7` + `oven-sh/setup-bun@v2`, then `bun install --frozen-lockfile` + `bun run check`
- **Release** — on tag `v*`: same checks, then `softprops/action-gh-release@v3`

```bash
git tag v0.4.0
git push origin v0.4.0
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

## Workflow docs layout

Features live in `docs/<slug>/`:

- `docs/<slug>/spec.md` and `docs/<slug>/plan.md` are **committed** (they travel with the branch).
- `docs/<slug>/sdd/` (progress ledger, `flow.json` approval state, briefs, review diffs) is **gitignored** — working state for the current cycle.

Consequences:

- A fresh clone starts every workflow at `draft` — the flow gates (`workflow_spec_approve` / `workflow_plan_approve` / `workflow_plan_menu`) must be re-run after checkout.
- The SDD state does not travel with the branch; spec/plan do.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Kudos

- **Superpowers** — the vendored `vendor/superpowers/skills/` (brainstorming, writing-plans, executing-plans, TDD, …) is by [Adam Wiggins](https://github.com/obra), vendored with attribution.
- **Ponytail mode** — the lazy-engineer skill (ponytail, ponytail-review, ponytail-audit, …) by [Dietrich Gebert](https://github.com/dietrichgebert), active in this project's OpenCode config and installed as a shared skill.

