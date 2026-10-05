# @brainervirus/workit-codex

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

Workit plugin for Codex CLI and desktop — native manifest, documented hooks, the shared MCP transport, and eleven method skills. Reads run over MCP; mutations run CLI-driven, because MCP is read-only for unattested callers.

## Requirements

- **Node.js ≥ 24**
- Codex CLI (`codex`) or Codex desktop

## Install

Register the plugin manifest and hooks per the Codex docs, pointing the MCP launcher at this package:

```bash
workit-codex-mcp    # shared-transport MCP server (reads)
workit-codex-hook   # documented SessionStart/PreToolUse/subagent hooks
```

## Usage

```bash
node_modules/.bin/workit <family> <action> --json [--actor <session-id>]   # mutations (CLI-driven)
```

The hook honors exactly the bound session and nothing else. Authority for Git and forge effects comes from Codex's own permissions plus the workspace autonomy grants (`workit grant show`). The package ships the eleven `workit-*` method skills in `skills/`, generated at build time from `packages/workit-core/skills`.
