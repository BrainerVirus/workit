# @brainervirus/workit-cli

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@brainervirus/workit-cli.svg)](https://www.npmjs.com/package/@brainervirus/workit-cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

The workit CLI — an interactive Ink wizard that configures workit for OpenCode, Cursor, Codex and Pi, plus upgrade tooling and an offline installation doctor.

## Requirements

- **Node.js ≥ 24** — the published CLI is a self-contained Node bundle (no Bun runtime). Node 23 and below fail (`ERR_MODULE_NOT_FOUND`/ESM syntax or the `>=24` engine gate).

## Install

```bash
npm i -g @brainervirus/workit-cli
# or run without installing:
npx @brainervirus/workit-cli init
```

## Usage

```bash
workit init              # basic / advanced setup wizard
workit upgrade [--hosts=opencode,cursor,codex,pi] [--cli] [--apply --confirm] [--json]
workit launch <opencode|cursor|codex|pi> [--auto-upgrade] [-- host arguments]
workit doctor            # offline installation health report
workit doctor --json     # machine-readable report
workit <family> <action> [--payload <json|@file|->] [--task <id>] [--revision <uuid>] [--workspace-revision <uuid|null>] [--view full] [--actor <id>] [--confirm] [--json]
workit action <operation> --payload <JSON> [--preview] [--confirm] [--task <id>] [--json]   # preview or run one approved external action
workit handoff --task <id> [--json]                   # export task state and compact destination context
workit uninstall                           # remove host registrations (keeps ~/.config/workit)
workit                                     # help
```

`workit init` guides you through: detected host selection, basic global config (locale, branch policy), optional advanced commit policy, YouTrack, VCS, workspaces (scoped hosting/tracker/branch/commit rules, profiles and release tracks), and project hygiene files. The wizard is a TTY application — `workit init` requires an interactive terminal and prints guidance (exiting nonzero) when stdin is not a TTY.

Authenticate GitHub or GitLab with `gh auth login` or `glab auth login` before hosting actions; Workit does not need a second provider token file. `workit action` Git/hosting payloads accept `cwd` to target any checkout while task state stays in the session directory. Non-Git directories can host tasks for OS work; YouTrack keeps its own permanent token.

The platforms step lists all four supported hosts. Installed tools are selected
initially; absent tools are disabled. Select all available, clear all, or pick
individual hosts. Apply uses native Codex marketplace and Pi package commands,
OpenCode registration, and a managed Cursor plugin copy. Existing explicit/local
pins and unrelated host settings are preserved.

Advanced workspace edits preserve existing custom fields. Narrow globs win over
broader matches independent of file order; equal-specificity ambiguity is
reported. A sample-checkout preview shows the selected scope and effective
policy source. GitHub and GitLab can both use YouTrack; GitHub Issues requires
GitHub. Inheritance removes an override instead of freezing global defaults.

`workit upgrade` previews targeted native package updates and known configuration
migrations. `--apply --confirm` backs up configuration, rejects stale previews,
and verifies the installed version. Local/exact pins are skipped; `--cli` also
updates an existing global npm CLI (`--hosts=none` targets only the CLI). For ephemeral use, invoke
`npx @brainervirus/workit-cli@latest`. JSONC OpenCode configuration currently
requires native inspection rather than automatic mutation.

OpenCode 2.0.21 cannot target a server plugin with its `plugin update` command
(verified in the official Docker image). Workit reports that limitation and
preserves the OpenCode registration; it never falls back to updating every
plugin or deleting caches. OpenCode package resolution remains host-owned.
Cursor, Codex and Pi use their supported scoped update paths.

`workit launch <host> --auto-upgrade -- <args>` performs optional upgrades before
launch. Stop other selected host instances first. Registry failure starts the
unchanged host with a warning; installer or verification failure prevents launch.
No startup hook updates an already loaded plugin, and no task-history migration
or host-permission change is performed.

`workit doctor` checks the offline installation health and exits nonzero when problems are found; `--json` prints the full report as JSON instead of the human-readable table.

The task surface exposes the eight shared operation families (`task`, `policy`,
`evidence`, `finding`, `decision`, `worker`, `writer`, and `state`) and their 24
closed actions. Payloads can be inline JSON, a UTF-8 `@file`, or UTF-8 stdin
with `-`; `--json` preserves the structured Result shape and exits nonzero for
failures. Headless mutations that require consent use `--confirm` (agent-reported)
or an observed TTY prompt; the action route additionally requires an
interactive TTY — headless action calls return `needs_input` even with
`--confirm`. `workit handoff --task` is read-only and refuses to
emit a handoff when export and inspection revisions differ.

## Behavior

- **Safe apply semantics** — a malformed `config.json` is detected before the wizard renders and reported as a friendly blocked output instead of crashing; the same guard runs after the Apply preview.
- **Stable interaction** — unchanged wizard inputs are no-ops; they settle without React render warnings and never discard draft state.
- **Clean terminal** — only `warn`/`error` diagnostics print to stderr; routine structured `info` records stay in the JSONL journal. Nonzero failures and human-readable errors remain visible.
- **Node support** — the packed CLI runs on Node 24+; installation on Node 24 emits no engine warning from workit's dependency tree.

## Package scripts

```bash
bun run build       # bundle dist/index.js (self-contained, Node shebang) + assets
bun run typecheck   # tsc --noEmit
```

The build produces a nonsplitting `dist/index.js` with a portable `#!/usr/bin/env node` shebang and copies the deterministic `assets/` (templates) from core.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
