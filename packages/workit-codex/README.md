# @brainervirus/workit-codex

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

Workit plugin for Codex CLI and desktop — native manifest, documented hooks, the shared MCP transport, and fourteen method skills. Reads run over MCP; mutations run CLI-driven, because caller-unattested MCP cannot attest effects.

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
node_modules/.bin/workit <family> <action> --json --confirm   # mutations (CLI-driven)
workit writer acquire --actor <session-id>                    # bind a writer to this session explicitly
```

The hook honors exactly the bound session and nothing else. Arbitrary-question receipts and attested writer delegation are unavailable on this host by design. See `skills/` for the fourteen `workit-*` method skills.
