# Workit

Multi-platform Superpowers workflow plugin for **Cursor** and **OpenCode**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform | Path | Version |
| --- | --- | --- |
| **OpenCode** | `packages/workit-opencode/src/plugin.ts` | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-opencode) |
| **Cursor** | `packages/workit-cursor/` (MCP + hooks + rules + skills) | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-cursor) |
| **Shared core** | `packages/workit-core/` (src, skills, commands, scripts, templates) | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-core) |
| **CLI** | `packages/workit-cli/` (Ink wizard, bin `workit`) | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-cli) |

Config directory (both platforms): `~/.config/workflow-toolkit/` (kept as-is for install stability).

[![npm version](https://img.shields.io/npm/v/@brainervirus/workit-opencode)](https://www.npmjs.com/package/@brainervirus/workit-opencode)
[![CI](https://img.shields.io/github/actions/workflow/status/BrainerVirus/workit/ci.yml?branch=main&label=CI)](https://github.com/BrainerVirus/workit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

**Quick start (wizard)** — the interactive wizard picks OpenCode and/or Cursor and configures tokens, workspaces, and project files:

```bash
npx @brainervirus/workit-cli init
```

The wizard installs the platform packages it configures (OpenCode plugin / Cursor MCP) — no manual `npm i` needed.

Requirements:
- **Node.js ≥ 20** (LTS) — the CLI is a node bundle; Node 16 and below fail (`ERR_MODULE_NOT_FOUND`/ESM syntax).
- [bun](https://bun.sh) — only for the OpenCode plugin runtime (the OpenCode side executes `.ts` directly); the wizard and CLI itself run on node.


**Local development** — use the repo path instead; no package cache, disk is the source of truth:

```bash
bun i
```

**Manual setup (skip the wizard)** — configure each tool by hand; see [Usage](#usage) for the OpenCode plugin entry and Cursor MCP server.

## Usage

Manual setup for those who skipped the wizard (`npx @brainervirus/workit-cli init`):

**OpenCode** — reference the plugin entry in `opencode.json` / `opencode.jsonc` (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brainervirus/workit-opencode"]
}
```

Local dev variant (absolute path to this repo):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/workit/packages/workit-opencode/src/plugin.ts"]
}
```

**Cursor** — the MCP server runs from the package's `cursor/` directory. Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "workit": {
      "command": "bun",
      "args": ["run", "node_modules/@brainervirus/workit-cursor/mcp/server.ts"]
    }
  }
}
```

Local dev variant: point `WORKFLOW_TOOLKIT_ROOT` at this repo's `packages/workit-core` (the MCP launcher `packages/workit-core/scripts/run-cursor-mcp.sh` resolves it), or run the install script from the repo.

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

## Repo layout

```
workit/
├── packages/
│   ├── workit-core/        # @brainervirus/workit-core — shared core
│   │   ├── src/            # core TS (src/core, src/tools, src/state)
│   │   ├── skills/         # OpenCode-native skills (wk-*)
│   │   ├── commands/       # OpenCode commands (wk-*)
│   │   ├── scripts/        # shared shell + installers (all logic in src/, TS via bun)
│   │   ├── templates/      # execution + superpowers contracts
│   │   └── vendor/         # vendored superpowers skills
│   ├── workit-opencode/    # @brainervirus/workit-opencode — OpenCode plugin (src/plugin.ts)
│   ├── workit-cursor/      # @brainervirus/workit-cursor — Cursor plugin (MCP, hooks, rules, skills)
│   └── workit-cli/         # @brainervirus/workit-cli — Ink setup wizard (bin: workit)
├── .github/workflows/      # CI + release
└── test/                   # bun tests (OpenCode plugin)
```

## CI / local checks

```bash
bun run check    # bun test + tsc + cursor MCP regressions
```

GitHub Actions:

- **CI** — on push/PR to `main`: matrix of 3 OS (ubuntu, macos, windows) running `actions/checkout@v7` + `oven-sh/setup-bun@v2`, then `bun install --frozen-lockfile` + `bun run check`
- **Release** — on push to `main`: [semantic-release](https://github.com/semantic-release/semantic-release) computes the next version from Conventional Commits, publishes the four workspaces to npm in dependency order — `workit-core`, `workit-opencode`, `workit-cursor`, `workit-cli` (with provenance), and creates the git tag + GitHub Release
- **Code review** — on every PR: the [OpenCode GitHub integration](https://opencode.ai/docs/github/) reviews the diff (see [Code review](#code-review))

No manual tags — semantic-release owns the version/tag flow:

```bash
git push origin main
```

## Code review

Automated OpenCode PR review was evaluated and **removed** (too slow for this repo's diff sizes — the review agent explored the whole repo instead of just the diff). The quality gate is the per-package CI checks (required in branch protection) plus the two-stage subagent review inside `wk-implement`.

Optional fast reviewers if you want machine review on PRs:
- [CodeRabbit](https://www.coderabbit.ai/) — instant AI review on every PR
- [Cursor Bugbot](https://cursor.com/dashboard/bugbot) — Cursor's PR review (appears as a required check)

To activate the review on a fork or fresh clone:

1. Install the [OpenCode GitHub app](https://github.com/apps/opencode-agent) on the repository.
2. Add the `OPENCODE_API_KEY` secret under Settings → Secrets and variables → Actions.
3. PRs trigger the review on opened/synchronized/reopened events automatically.

[Cursor Bugbot](https://cursor.com/dashboard/bugbot) is an optional alternative to the OpenCode review.

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
