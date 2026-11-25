# @workit-dev/codex

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for Codex CLI and desktop: native plugin manifest,
documented lifecycle hooks, the shared MCP server and the thirteen method skills.
Requires Node.js 24+.

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workit
```

Update with `workit upgrade` (native fallback: `codex plugin marketplace upgrade workit && codex plugin add workit@workit`), then start a new Codex session; uninstall with `workit uninstall`.

Reads run over MCP (`workit-codex-mcp`); mutations run through the `workit`
CLI because MCP is read-only for unattested callers. Invoke skills as
`$workit-<name>` or from `/skills`. Codex permissions and sandbox stay
authoritative.

The plugin ships the `workit-implementer`, `workit-verifier`,
`workit-reviewer`, `workit-decider` and `workit-babysitter` custom agents,
which the MCP server copies into `~/.codex/agents/`; trust the plugin hooks
with `/hooks`. Agents, hooks, the before-write gate on `apply_patch` and the
doctor rows are in
[the hosts guide](https://github.com/BrainerVirus/workit/blob/main/docs/guides/hosts.md#codex-cli--desktop). Delivery limits come from the workspace
[grants](https://github.com/BrainerVirus/workit/blob/main/docs/guides/grants.md).
