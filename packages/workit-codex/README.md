# @brainervirus/workit-codex

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for Codex CLI and desktop: native plugin manifest,
documented lifecycle hooks, the shared MCP server and the eleven method skills.
Requires Node.js 24+.

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workflow-toolkit
```

Reads run over MCP (`workit-codex-mcp`); mutations run through the `workit`
CLI because MCP is read-only for unattested callers. Invoke skills as
`$workit-<name>` or from `/skills`. Codex permissions and sandbox stay
authoritative. Codex PreToolUse does not see `apply_patch` edits, so the
[before-write gate](https://github.com/BrainerVirus/workit/blob/main/docs/guides/verification.md) is advisory here (the session
context says so). Delivery limits come from the workspace
[grants](https://github.com/BrainerVirus/workit/blob/main/docs/guides/grants.md).
