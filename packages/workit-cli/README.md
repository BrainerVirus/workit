# @brainervirus/workit-cli

The workit CLI — an interactive Ink wizard that configures workit for OpenCode and/or Cursor, plus an offline installation doctor.

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
workit init              # interactive setup wizard
workit doctor            # offline installation health report
workit doctor --json     # machine-readable report
workit <family> <action> [--payload <json|@file|->] [--task <id>] [--revision <uuid>] [--workspace-revision <uuid|null>] [--view full] [--confirm] [--json]
workit action <operation> --payload <JSON> [--preview] [--confirm] [--task <id>] [--json]   # preview or run one approved external action
workit handoff --task <id> [--json]                   # export task state and compact destination context
workit cutover preview [--hosts ..] [--json] | apply [--hosts ..] [--resolution k=v] [--confirm] | rollback preview|apply <backupId> [--json] [--confirm]
workit uninstall                           # remove host registrations (keeps ~/.config/workit)
workit                                     # help
```

`workit init` guides you through: platform selection (OpenCode/Cursor), global config (locale, timezone, branch policy), YouTrack, VCS, workspaces (path globs → provider), and project hygiene files. The wizard is a TTY application — `workit init` requires an interactive terminal and prints guidance (exiting nonzero) when stdin is not a TTY.

`workit doctor` checks the offline installation health and exits nonzero when problems are found; `--json` prints the full report as JSON instead of the human-readable table.

The task surface exposes the eight shared operation families (`task`, `policy`,
`evidence`, `finding`, `decision`, `worker`, `writer`, and `state`) and their 24
closed actions. Payloads can be inline JSON, a UTF-8 `@file`, or UTF-8 stdin
with `-`; `--json` preserves the structured Result shape and exits nonzero for
failures. Headless mutations that require consent use `--confirm` (agent-reported)
or an observed TTY prompt; `workit handoff --task` is read-only and refuses to
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
