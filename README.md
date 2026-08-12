# Workit

Multi-platform Superpowers workflow plugin for **Cursor** and **OpenCode**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Platform        | Path                                                                | Version                                                            |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **OpenCode**    | `packages/workit-opencode/src/plugin.ts`                            | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-opencode) |
| **Cursor**      | `packages/workit-cursor/` (MCP + hooks + rules + skills)            | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-cursor)   |
| **Shared core** | `packages/workit-core/` (src, skills, commands, scripts, templates) | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-core)     |
| **CLI**         | `packages/workit-cli/` (Ink wizard, bin `workit`)                   | ![npm](https://img.shields.io/npm/v/@brainervirus/workit-cli)      |

Config directory (both platforms): `~/.config/workit/` — legacy `~/.config/workflow-toolkit/` is auto-migrated on first run and kept as a fallback.

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

## Features

- **Document-driven development** — write `docs/<slug>/spec.md` + `plan.md`, gate approvals with native question receipts, execute plans task-by-task with delegated subagent implementation, review, and SDD progress tracking.
- **12 `wk-*` commands/skills** on both platforms: `wk-init`, `wk-status`, `wk-verify`, `wk-commit`, `wk-pr`, `wk-changelog`, `wk-release-notes`, `wk-docs-refresh`, `wk-handoff`, `wk-implement`, `wk-meetings`, `wk-issue-update`.
- **43 `workflow_*` MCP tools on Cursor** (native plugin tools on OpenCode) — branch setup, PR create/context, docs validate/promote, YouTrack post/log, templates, rules, present (ASCII/mermaid), doctor, handoff.
- **Per-turn contract rails** — brainstorming-before-code, TDD, verification-before-completion, systematic-debugging, receiving-code-review, doc-delivery, config-guard, issue-rail reminders and post-hoc detectors.
- **Secret-safe diagnostics** — structured JSONL logger with redaction, offline doctor (11 install checks), truthful readiness.
- **Vendored Superpowers skills** (14) + optional Ponytail mode — lazy-engineer ruleset as a shared skill.
- **Multi-context workspaces** — one install, per-repo VCS provider/PR target/issue linking (see [Per-install configuration](#per-install-configuration)).

## Flows

1. **Init** — `/wk-init` (or `npx @brainervirus/workit-cli init`) scaffolds config, tokens, gitignore, and hygiene files; `/wk-status` verifies everything (config, tokens, YouTrack + VCS APIs).
2. **Build a feature** — brainstorming writes the spec, writing-plans writes the plan, `/wk-implement` executes approved plans with per-task reviews; flow gates (`workflow_spec_approve` / `workflow_plan_approve` / `workflow_plan_menu`) require native-question approval evidence.
3. **Verify** — `/wk-verify` discovers and runs the repo's validation (lint, format, tests, build, changelog format) and reports each check's exit status.
4. **Commit & PR** — `/wk-commit` previews a Conventional Commit on an allowed branch; `/wk-pr` gathers branch-exclusive context, links issues (GitHub issues or YouTrack), and creates the PR/MR with your provider CLI (`gh` for GitHub, `glab` for GitLab).
5. **Changelog & release notes** — `/wk-changelog` applies Keep a Changelog entries; `/wk-release-notes` drafts notes for a release range.
6. **Handoff** — `/wk-handoff` seeds a new session with spec/plan state, active branch, and context.
7. **YouTrack** — `/wk-issue-update` drafts (es-CL) and posts reviewed task updates with time; `/wk-meetings` logs meeting time only.
8. **Docs** — `/wk-docs-refresh` updates documentation affected by changes; `workflow_docs_validate` hard-fails invalid spec/plan pairs before execution.

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

**Cursor** — the MCP server runs from the package's self-contained Node bundle. Add to `.cursor/mcp.json` (or install the plugin, whose `.cursor-plugin/plugin.json` registers the same package-relative server):

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

Local dev variant: point `WORKFLOW_TOOLKIT_ROOT` at this repo's `packages/workit-core` (the MCP launcher `packages/workit-core/scripts/run-cursor-mcp.sh` resolves it), or run the install script from the repo.

## Requirements

- **Node.js ≥ 20** — the published CLI, OpenCode plugin, and Cursor MCP/hook artifacts run on Node 20+ (CI exercises Node 20 and 22).
- **Bun 1.3.14** — development, build, and test runtime. Install once:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then add to your shell profile (or rely on the MCP launcher's `~/.bun/bin/bun` fallback):

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

- **OpenCode ≥ 1.15.0** — the OpenCode plugin pins `@opencode-ai/plugin` 1.17.7; 1.15.0 is the declared minimum (both are exercised by the packed-runtime gate).
- **Git** — branch resolution, SDD review diffs, and verify gates.
- **Provider CLI for PRs/MRs** — installed **and authenticated**:
  - **`gh`** (GitHub CLI) for GitHub-hosted repos: `gh auth login`
  - **`glab`** (GitLab CLI) for GitLab-hosted repos: `glab auth login`

  The provider is resolved per repository: an explicit workspace `vcs.provider` wins, otherwise the origin remote decides (`github.com` → `gh`, `gitlab.com` → `glab`), otherwise the configured `vcs.json` provider. `workflow_pr_create` fails with an install/auth hint when the needed CLI is missing or unauthenticated.

## Per-install configuration

Everything lives in `~/.config/workit/` (legacy `~/.config/workflow-toolkit/` auto-migrates). Tokens are never printed by tools; you edit token files locally.

| File                                               | Purpose                | Key fields                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                      | Global preferences     | `locale`, `timezone`, `branchPolicy: { preset: gitflow \| github-flow \| trunk-based \| custom, allowed, protected }`                                                                                                                                   |
| `youtrack.json`                                    | YouTrack integration   | `baseUrl`, `tokenFile`, `timezone`, `locale`, `defaultMention`, `meetingIssue`/`meetingIssues`, `greetings`, `commentHeader`, `tokenDefaults`                                                                                                           |
| `vcs.json`                                         | VCS defaults           | `provider: gitlab \| github`, `defaultTargetBranch`, per-provider `{ host, apiUrl, tokenFile }`, `pr: { squashOnMerge, removeSourceBranch, pushBranch, confirmSkip }`                                                                                   |
| `workspaces.json`                                  | **Per-repo contexts**  | `workspaces: [{ name, glob, branchPolicy: { preset, developBranch, prefixes, allowed, protected, integration: pr \| merge }, vcs: { provider, defaultTargetBranch }, youtrack: { baseUrl, link_issues }, issues: { provider: "github", link_on_pr } }]` |
| `youtrack.token` / `gitlab.token` / `github.token` | Credentials (mode 600) | created as placeholders by `/wk-init`; replace `YOUR_TOKEN_HERE` locally                                                                                                                                                                                |

**Multi-context setup (personal + work in one install)** — `workspaces.json` scopes VCS provider, PR target, and issue linking per repository glob, e.g.:

```json
{
  "workspaces": [
    {
      "name": "personal",
      "glob": "/home/you/projects/personal/**",
      "vcs": { "provider": "github", "defaultTargetBranch": "main" },
      "issues": { "provider": "github", "link_on_pr": true }
    },
    {
      "name": "work",
      "glob": "/home/you/projects/work/**",
      "branchPolicy": { "preset": "gitflow", "integration": "merge" },
      "vcs": { "provider": "gitlab", "defaultTargetBranch": "develop" },
      "youtrack": { "link_issues": true }
    }
  ]
}
```

Note: `branchPolicy` is now per-workspace (workspace > global `config.json` > preset defaults); the YouTrack meeting/comment configuration remains global. Per-workspace `vcs.provider`/`defaultTargetBranch`/issue linking are the other workspace-scoped knobs.

Run the init action (`workflow_toolkit_init_apply action=branch_policy` on OpenCode/Cursor, or the CLI wizard's branch-policy screen) to detect and pin a repo's convention: `develop` present → gitflow/merge; only `main` → github-flow/pr; only `master` → trunk-based/pr. Re-running updates the entry (already-configured when unchanged).

Environment overrides: `WORKFLOW_TOOLKIT_CONFIG`, `WORKFLOW_TOOLKIT_STATE`, `WORKFLOW_WORKSPACE_ROOT`, `WORKFLOW_VCS_PROVIDER`, `WORKFLOW_VCS_TARGET_BRANCH`, `WORKFLOW_YT_BASE_URL`, `WORKFLOW_YT_MENTION`, `WORKFLOW_YT_MEETING_ISSUE`, `WORKFLOW_YT_TIMEZONE`, `WORKFLOW_GH_ISSUE` (+ `WORKFLOW_GH_ISSUE_RELATION`).

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

No manual tags — semantic-release owns the version/tag flow:

```bash
git push origin main
```

## Quality gates

- **CI checks** — the per-package check jobs (workit-core/opencode/cursor/cli/shared) are required in branch protection; the PR cannot merge while any is red.
- **Subagent review** — `wk-implement` runs a two-stage review (spec compliance + code quality) per task with fresh `general` agents.

## Architecture

| Concern          | OpenCode                | Cursor                                                |
| ---------------- | ----------------------- | ----------------------------------------------------- |
| Tools            | native plugin           | MCP server                                            |
| Session contract | `messages.transform`    | `sessionStart` hook                                   |
| Handoff          | spawns OpenCode session | handoff prompt                                        |
| Shared logic     | `scripts/`              | `scripts/` via `WORKFLOW_TOOLKIT_ROOT`                |
| Install root     | GitHub plugin pin       | `~/.local/share/workflow-toolkit` + local plugin copy |

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
