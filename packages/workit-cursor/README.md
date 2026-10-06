# @brainervirus/workit-cursor

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainervirus/workit-cursor.svg)](https://www.npmjs.com/package/@brainervirus/workit-cursor)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for Cursor: the shared MCP server, one native hook
dispatcher, the `workit-contract` rule, the eleven method skills and `/wk-*`
commands. Requires Node.js 24+ and network access on first run.

## Install

```bash
npx @brainervirus/workit-cli init   # select Cursor
```

The wizard copies the plugin into `~/.cursor/plugins/local/workit` (a real
directory) and registers the MCP server and hooks. Manual MCP config and host
limits: [hosts guide](https://github.com/BrainerVirus/workit/blob/main/docs/guides/hosts.md#cursor).

## Runtime

The MCP server and hooks run through
`npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest …`,
so manifests carry no repository-relative `dist` paths. The age override
works around npm/cli#9765; `workit doctor` enforces this exact shape. MCP is
read-only for unattested callers; mutations run through the `workit` CLI.
The `preToolUse` hook applies the [before-write gate](https://github.com/BrainerVirus/workit/blob/main/docs/guides/verification.md)
to write tools while the branch task has an open product choice or needs a
plan.

## Marketplace

The repository root carries `.cursor-plugin/marketplace.json` indexing this
package. Cursor installs Marketplace plugins from git without building, so
`skills/`, `commands/`, `rules/` and assets are committed; regenerate skills
with `bun packages/workit-cursor/scripts/build.ts --skills-only`.
`bun run validate:cursor-marketplace` checks the artifact against the pinned
Cursor schemas. The plugin is submission-ready but not published there.
