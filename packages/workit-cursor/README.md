# @workit-dev/cursor

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@workit-dev/cursor.svg)](https://www.npmjs.com/package/@workit-dev/cursor)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for Cursor: the shared MCP server, one native hook
dispatcher, the `workit-contract` rule, the thirteen method skills and `/wk-*`
commands, and the `workit-verifier`, `workit-reviewer`, `workit-decider` and
`workit-babysitter` agents. Requires Node.js 24+ and network access on first run.

## Install

```bash
npx @workit-dev/cli init   # select Cursor
```

The wizard copies the plugin into `~/.cursor/plugins/local/workit` (a real
directory) and registers the MCP server and hooks. Manual MCP config and host
limits: [hosts guide](https://github.com/BrainerVirus/workit/blob/main/docs/guides/hosts.md#cursor).
Update with `workit upgrade` (it reinstalls missing plugin files); uninstall with `workit uninstall`.

## Runtime

The MCP server runs through `npx` (read-only for unattested callers; mutations
run through the `workit` CLI). Hooks run through the plugin's launcher, which
fails open with a `[workit] Cursor hook unavailable` line while the hook's own
denials still block; the `preToolUse` hook applies the before-write gate.
Launcher order, doctor rows and host limits:
[hosts guide](https://github.com/BrainerVirus/workit/blob/main/docs/guides/hosts.md#cursor).

## Marketplace

The repository root carries `.cursor-plugin/marketplace.json` indexing this
package. Cursor installs Marketplace plugins from git without building, so
`skills/`, `commands/`, `rules/` and assets are committed; regenerate skills
with `bun packages/workit-cursor/scripts/build.ts --skills-only`.
`bun run validate:cursor-marketplace` checks the artifact against the pinned
Cursor schemas. The plugin is submission-ready but not published there.
