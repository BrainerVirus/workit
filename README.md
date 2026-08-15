# Workit

Multi-platform Superpowers workflow plugin for **Cursor**, **OpenCode**, and the **CLI**: verify, PR, changelog, commits, SDD implementation, session handoff, YouTrack, and deterministic UI presentation.

| Package         | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| **OpenCode**    | `packages/workit-opencode/` — native plugin (commands, skills, tools)       |
| **Cursor**      | `packages/workit-cursor/` — MCP + hooks + rules + skills plugin             |
| **Shared core** | `packages/workit-core/` — shared logic, skills, commands, scripts, templates |
| **CLI**         | `packages/workit-cli/` — Ink setup wizard + doctor (bin `workit`)           |

Config directory (both platforms): `~/.config/workit/` — legacy `~/.config/workflow-toolkit/` was auto-migrated on first run, then its non-secret files were removed after the active config passed status checks; the runtime reads only the active config dir.

[![npm version](https://img.shields.io/npm/v/@brainervirus/workit-opencode)](https://www.npmjs.com/package/@brainervirus/workit-opencode)
[![CI](https://img.shields.io/github/actions/workflow/status/BrainerVirus/workit/ci.yml?branch=main&label=CI)](https://github.com/BrainerVirus/workit/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

**Quick start (wizard)** — the interactive wizard picks OpenCode and/or Cursor and configures tokens, workspaces, and project files:

```bash
npx @brainervirus/workit-cli init
```

The wizard installs the platform packages it configures (OpenCode plugin / Cursor plugin) — no manual `npm i` needed.

Requirements for the published packages:

- **Node.js ≥ 22** — the CLI, OpenCode plugin, and Cursor MCP/hook artifacts are self-contained Node bundles. Node 21 and below fail (`ERR_MODULE_NOT_FOUND`/ESM syntax or the `>=22` engine gate).
- **Bun** — development, build, and test only (see [Development](#development)). Published artifacts do not run through Bun.

**Local development** — use the repo path instead; no package cache, disk is the source of truth:

```bash
bun i
```

**Manual setup (skip the wizard)** — configure each tool by hand; see [Usage](#usage) for the OpenCode plugin entry and Cursor MCP server.

## Features

- **Document-driven development** — write `docs/<slug>/spec.md` + `plan.md`, gate approvals with native question receipts, execute plans task-by-task with delegated subagent implementation, review, and SDD progress tracking.
- **Approval integrity** — approvals bind to the document's exact bytes via a SHA-256 digest; editing an approved spec or plan after approval invalidates it and forces a fresh reapproval before execution can resume.
- **Execution lifecycle** — every approved plan moves through exactly four states (`pending` → `active` → `paused`/`active` → `completed`) with verified completion (SDD ledger complete + repository verification passing) and active-only subagent interception.
- **12 `wk-*` skills** on OpenCode and Cursor (`wk-init`, `wk-status`, `wk-verify`, `wk-commit`, `wk-pr`, `wk-changelog`, `wk-release-notes`, `wk-docs-refresh`, `wk-handoff`, `wk-implement`, `wk-meetings`, `wk-issue-update`); the CLI exposes `workit init`, `workit doctor`, `workit flow`, and `workit handoff`.
- **`workflow_*` tools** — branch setup, PR create/context, docs validate/promote, YouTrack post/log/time, templates, rules, presentation (ASCII/mermaid), doctor, handoff, and plan lifecycle (`workflow_plan_pause`/`resume`/`complete`) (native plugin tools on OpenCode, an MCP server on Cursor).
- **Post-plan menus** — after the plan is approved an ordinary session presents five choices (Subagent-driven, Inline, Handoff, Review spec first, Review plan first); a handoff-destination session presents exactly four (never Handoff again).
- **Per-turn contract rails** — brainstorming-before-code, TDD, verification-before-completion, systematic-debugging, receiving-code-review, doc-delivery, config-guard, and issue-rail reminders plus post-hoc detectors.
- **Secret-safe diagnostics** — structured JSONL logger with redaction and an offline doctor for truthful readiness.
- **Vendored Superpowers skills** (14) + optional Ponytail mode — lazy-engineer ruleset as a shared skill.
- **Multi-context workspaces** — one install, per-repo VCS provider/PR target/issue linking (see [Per-install configuration](#per-install-configuration)).

## Host capabilities

Feature parity across hosts, implemented the best way each host allows. Core logic lives in `packages/workit-core`; each host adapts its native surfaces to it.

| Capability     | OpenCode                                          | Cursor                                                        | CLI                                |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Approval       | native `question` tool receipts (`attested: true`) | AskQuestion, policy-only (`attested: false`)                   | `--confirm` flags / TTY prompts    |
| Implementation | subagent-driven task delegation (native `task`)    | not supported (no delegated identity)                          | n/a                                |
| Lifecycle      | `workflow_plan_pause`/`resume`/`complete` (receipts) | `workflow_plan_pause`/`resume`/`complete` (policy-only)         | `workit flow pause\|resume\|complete` (`--confirm`) |
| Commit         | `wk-commit` + native `question` confirmation       | `wk-commit`, policy-only                                       | n/a                                |
| Handoff        | spawns a native OpenCode session                   | seeds a handoff prompt for the next agent                      | `workit handoff` (prints the destination prompt) |
| Tools          | native plugin tools                                | MCP server (`workflow_*`)                                      | `workit` commands                  |
| Skills         | `skills.paths` + vendored dirs                     | plugin `skills/` dirs                                          | n/a                                |
| Diagnostics    | JSONL journal + native `client.app.log()`          | redacted stderr (stdout stays protocol-only)                   | `warn`/`error` on stderr           |

## Flows

1. **Init** — `/wk-init` (or `npx @brainervirus/workit-cli init`) scaffolds config, tokens, gitignore, and hygiene files; `/wk-status` verifies everything (config, tokens, YouTrack + VCS APIs).
2. **Build a feature** — brainstorming writes the spec, writing-plans writes the plan, `/wk-implement` executes approved plans with per-task reviews; flow gates (`workflow_spec_approve` / `workflow_plan_approve` / `workflow_plan_menu`) require native-question approval evidence, and approvals bind to the exact SHA-256 digest of the approved document.
3. **Execute & lifecycle** — `workflow_plan_pause` / `workflow_plan_resume` / `workflow_plan_complete` (OpenCode receipts, Cursor policy-only, CLI `workit flow … --confirm`) move the plan through `pending`/`active`/`paused`/`completed`; completion requires a complete SDD ledger and passing repository verification.
4. **Verify** — `/wk-verify` discovers and runs the repo's validation (lint, format, tests, build, changelog format) and reports each check's exit status.
5. **Commit & PR** — `/wk-commit` previews a Conventional Commit on an allowed branch; `/wk-pr` gathers branch-exclusive context, links issues (GitHub issues or YouTrack), and creates the PR/MR with your provider CLI (`gh` for GitHub, `glab` for GitLab). On GitHub the branch is pushed first (`git push -u origin <branch>` when `pr.pushBranch` is enabled) so `gh pr create` never runs against an unpushed branch.
6. **Changelog & release notes** — `/wk-changelog` applies Keep a Changelog entries; `/wk-release-notes` drafts notes for a release range.
7. **Handoff** — `/wk-handoff` seeds a new session with spec/plan state, active branch, and context; the destination session presents a four-choice menu (never the originating Handoff option) and carries the handoff-destination marker.
8. **YouTrack** — `/wk-issue-update` drafts (es-CL) and posts reviewed task updates with time; `/wk-meetings` logs meeting time only.
9. **Docs** — `/wk-docs-refresh` updates documentation affected by changes; `workflow_docs_validate` hard-fails invalid spec/plan pairs before execution.

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

A local (non-npm) Cursor install lives at `~/.cursor/plugins/local/workit` and registers `enabled_plugins.workit = true`; the installer migrates exact legacy `workflow-toolkit` entries after the replacement succeeds. Marketplace installation, the MCP/hook runtime, and the authenticated submission flow are documented in the [Cursor package README](packages/workit-cursor/README.md#marketplace). The Cursor runtime runs from the exact reviewed pin `@brainervirus/workit-cursor@0.8.0` — runtime pins are deliberate reviewed updates made only after the target npm version is public, never a mutable `latest` dist-tag.

## Requirements

- **Node.js ≥ 22** — the published CLI, OpenCode plugin, and Cursor MCP/hook artifacts run on Node 22+ (Ink 7 requires Node ≥ 22).
- **Bun 1.3.14** — development, build, and test runtime only. Install once:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then add to your shell profile (or rely on the MCP launcher's `~/.bun/bin/bun` fallback):

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

- **OpenCode ≥ 1.15.0** — the declared minimum OpenCode host; the build pins the SDK at 1.17.7 (bundled into the plugin, not a runtime dependency).
- **Git** — branch resolution, SDD review diffs, and verify gates.
- **Provider CLI for PRs/MRs** — installed **and authenticated**:
  - **`gh`** (GitHub CLI) for GitHub-hosted repos: `gh auth login`
  - **`glab`** (GitLab CLI) for GitLab-hosted repos: `glab auth login`

  Provider and default target are resolved per repository in the order: explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults (gitflow → `develop`, github-flow → `main`, trunk-based → `master`, custom → `develop`). An explicit workspace `vcs.provider` wins over the origin remote, which decides (`github.com` → `gh`, `gitlab.com` → `glab`) only when the workspace does not specify one. A matched workspace's branchPolicy default is authoritative — a global `vcs.json` `defaultTargetBranch` can no longer shadow it. For GitHub, `prCreate` pushes the branch (`git push -u origin <branch>`) before `gh pr create` when `pr.pushBranch` is enabled (default) and returns a structured `push failed` result when the push fails; `pr.pushBranch: false` disables the push (GitLab uses `glab mr create --push`). A caller-supplied `target_branch`/`WF_PR_TARGET` equal to the resolved default (`main` under github-flow, `develop` under gitflow) is accepted even though protected; genuine differing overrides to protected or disallowed branches are rejected. `workflow_pr_create` fails with an install/auth hint when the needed CLI is missing or unauthenticated.

## Per-install configuration

Everything lives in `~/.config/workit/`; legacy `~/.config/workflow-toolkit/` was auto-migrated on first run and its non-secret files (config.json, vcs.json, youtrack.json, workspaces.json, templates/) were removed once the active config passed status checks — the runtime reads only the active config dir. Tokens are never printed by tools; you edit token files locally.

| File                                               | Purpose                | Key fields                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                      | Global preferences     | `locale`, `timezone`, `branchPolicy: { preset: gitflow \| github-flow \| trunk-based \| custom, allowed, protected }`                                                                                                                                   |
| `youtrack.json`                                    | YouTrack integration   | `baseUrl`, `tokenFile`, `timezone`, `locale`, `defaultMention`, `meetingIssue`/`meetingIssues`, `greetings`, `commentHeader`, `tokenDefaults`                                                                                                           |
| `vcs.json`                                         | VCS defaults           | `provider: gitlab \| github`, per-provider `{ host, apiUrl, tokenFile }`, `pr: { squashOnMerge, removeSourceBranch, pushBranch, confirmSkip }`. A global `defaultTargetBranch` is optional and applies to repos without a workspace branchPolicy or explicit `vcs.defaultTargetBranch`. |
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

Note: `branchPolicy` is per-workspace, with target default precedence: explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults; a matched workspace's branchPolicy default (gitflow → `develop`, github-flow → `main`) is authoritative over any global `vcs.json` default. The YouTrack meeting/comment configuration remains global. Per-workspace `vcs.provider`/`defaultTargetBranch`/issue linking are the other workspace-scoped knobs.

Run the init action (`workflow_toolkit_init_apply action=branch_policy` on OpenCode/Cursor, or the CLI wizard's branch-policy screen) to detect and pin a repo's convention: `develop` present → gitflow/merge; only `main` → github-flow/pr; only `master` → trunk-based/pr. Re-running updates the entry (already-configured when unchanged).

Environment overrides: `WORKFLOW_TOOLKIT_CONFIG`, `WORKFLOW_TOOLKIT_STATE`, `WORKFLOW_WORKSPACE_ROOT`, `WORKFLOW_VCS_PROVIDER`, `WORKFLOW_VCS_TARGET_BRANCH`, `WORKFLOW_YT_BASE_URL`, `WORKFLOW_YT_MENTION`, `WORKFLOW_YT_MEETING_ISSUE`, `WORKFLOW_YT_TIMEZONE`, `WORKFLOW_GH_ISSUE` (+ `WORKFLOW_GH_ISSUE_RELATION`).

## Troubleshooting

`workit doctor` (or `workflow_doctor`) checks the offline installation health and reports each check with a fix hint; it exits nonzero when problems are found.

```bash
npx @brainervirus/workit-cli doctor          # human-readable report
npx @brainervirus/workit-cli doctor --json   # machine-readable report
```

Checks cover the runtime, toolchain versions, assets, launchers/hooks, stale plugin pins, duplicate registrations, malformed config, workspace mismatches, credential metadata, and log writability.

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
│   ├── workit-opencode/    # @brainervirus/workit-opencode — OpenCode plugin (src/plugin.ts → dist/plugin.js)
│   ├── workit-cursor/      # @brainervirus/workit-cursor — Cursor plugin (MCP, hooks, rules, skills)
│   └── workit-cli/         # @brainervirus/workit-cli — Ink setup wizard (bin: workit)
├── .github/workflows/      # CI + release
└── test/                   # bun tests (per package + artifact gates)
```

## Development

Published artifacts are built with Bun and run on Node. Build, check, and verify from the repo:

```bash
bun run build                 # build the OpenCode, Cursor, and CLI bundles
bun run check                 # build + lint + format:check + bun test + tsc --noEmit
bun run verify:release-candidate  # pack every package and verify the local tarballs (no publish)
bun run validate:cursor-marketplace  # validate the Marketplace artifact against official Cursor schemas
```

Each package also exposes its own scripts:

| Package | Scripts |
| --- | --- |
| `workit-core` | `typecheck` |
| `workit-opencode` | `build`, `typecheck` |
| `workit-cursor` | `build` |
| `workit-cli` | `build`, `typecheck` |

## CI / release

GitHub Actions:

- **CI** (`ci.yml`) — on push/PR to `main`: per-package check jobs (`workit-core` on a 3-OS matrix, `workit-opencode`/`workit-cursor`/`workit-cli`/`shared` on ubuntu) run `bun test test/<package>` plus whole-repo typecheck (and lint/format in `shared`). An `artifacts` job runs the packed-artifact, registration, and manifest gates on a 3-OS × Node 22 matrix, and a `candidate` job packs and gates the release candidate without publishing. The Cursor and candidate jobs also run `validate:cursor-marketplace` against the official Cursor schemas. The pinned toolchain and host versions are declared in `packages/workit-core/src/core/support-matrix.ts` and enforced by tests.
- **Release** (`release.yml`) — on push to `main`: build the adapters, run `verify:release-candidate`, then `npx semantic-release`.

### Versioning

[semantic-release](https://github.com/semantic-release/semantic-release) computes the next version from Conventional Commits and publishes the four workspaces to npm in dependency order (`workit-core`, `workit-opencode`, `workit-cursor`, `workit-cli`), then creates the git tag + GitHub Release.

No manual tags — semantic-release owns the version/tag flow:

```bash
git push origin main
```

The repository's package manifests carry a fixed source version; semantic-release rewrites workspace versions **in CI only** (`packages/workit-core/scripts/rewrite-workspace-deps.ts`, run as `verifyConditionsCmd`/`prepareCmd`) and never commits the rewrite back. As a result the source manifests and the published npm versions can diverge; the [CHANGELOG](CHANGELOG.md) is the source of truth for released versions. npm provenance (OIDC trusted publishing) is not yet enabled — the release authenticates with `NPM_TOKEN`.

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
- Approvals are bound to the exact SHA-256 digest of the approved document bytes: editing a spec or plan after approval invalidates the approval and the digest must be re-approved before execution continues.
- The SDD state does not travel with the branch; spec/plan do.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Kudos

- **Superpowers** — the vendored `vendor/superpowers/skills/` (brainstorming, writing-plans, executing-plans, TDD, …) is by [Adam Wiggins](https://github.com/obra), vendored with attribution.
- **Ponytail mode** — the lazy-engineer skill (ponytail, ponytail-review, ponytail-audit, …) by [Dietrich Gebert](https://github.com/dietrichgebert), active in this project's OpenCode config and installed as a shared skill.
