# @brainervirus/workit-cli

The workit CLI — an interactive Ink wizard that configures workit for OpenCode and/or Cursor, plus an offline installation doctor.

## Requirements

- **Node.js ≥ 20** — the published CLI is a self-contained Node bundle (no Bun runtime). Node 16 and below fail (`ERR_MODULE_NOT_FOUND`/ESM syntax).

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
workit                   # help
```

`workit init` guides you through: platform selection (OpenCode/Cursor), global config (locale, timezone, branch policy), YouTrack, VCS, workspaces (path globs → provider), and project hygiene files. The wizard is a TTY application — `workit init` requires an interactive terminal and prints guidance (exiting nonzero) when stdin is not a TTY.

`workit doctor` checks the offline installation health and exits nonzero when problems are found; `--json` prints the full report as JSON instead of the human-readable table.

## Behavior

- **Safe apply semantics** — a malformed `config.json` is detected before the wizard renders and reported as a friendly blocked output instead of crashing; the same guard runs after the Apply preview.
- **Stable interaction** — unchanged wizard inputs are no-ops; they settle without React render warnings and never discard draft state.
- **Clean terminal** — only `warn`/`error` diagnostics print to stderr; routine structured `info` records stay in the JSONL journal. Nonzero failures and human-readable errors remain visible.
- **Node support** — the packed CLI runs on Node 20+; installation on Node 22.19 emits no engine warning from workit's dependency tree.

## Package scripts

```bash
bun run build       # bundle dist/index.js (self-contained, Node shebang) + assets
bun run typecheck   # tsc --noEmit
```

The build produces a nonsplitting `dist/index.js` with a portable `#!/usr/bin/env node` shebang and copies the deterministic `assets/` (templates) from core.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
