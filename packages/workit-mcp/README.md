# @brainervirus/workit-mcp

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

Shared low-level MCP transport for the eight workit operation families (`workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, `workit_state`). Host wiring stays adapter-owned: Cursor and Codex register this server and keep their native surfaces.

## Requirements

- **Node.js ≥ 24**

## Usage

```bash
workit-mcp    # stdio MCP server: tools plus workit://context/{kind} resources
```

Read-only contexts (`git`, `pr`, `youtrack`, `github_issue`, `gitlab_issue`, `changelog`, `release`, `affected`) are exposed as resources and need no approval or writer. Mutations are unavailable over caller-unattested MCP by design — they run through each host's attested surface.
