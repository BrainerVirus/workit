# @brainervirus/workit-cli

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainervirus/workit-cli.svg)](https://www.npmjs.com/package/@brainervirus/workit-cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

The `workit` command: setup wizard, doctor and upgrades, plus the delivery
verbs agents use (`check`, `ledger`, `git`, `pr`, `ci`, `stack`,
`verify-delivery`, `grant`, `task`, …). Requires Node.js 24+; the published
CLI is a self-contained Node bundle.

```bash
npm i -g @brainervirus/workit-cli
workit init        # interactive setup for Claude Code, OpenCode, Cursor, Codex and Pi
workit doctor      # offline installation health
workit help        # every verb; `workit help <verb>` for one
```

Or run once without installing: `npx @brainervirus/workit-cli init`.

Agents and hooks call `workit` from PATH. `workit doctor` warns (`workit_on_path`)
when none is found, when it does not run, or when it is older than an installed
host plugin, and prints the `npm i -g` (or `npx`) command for the matching version.

See the root [README](https://github.com/BrainerVirus/workit) for concepts and the
[CLI reference](https://github.com/BrainerVirus/workit#cli-reference), and the
[guides](https://github.com/BrainerVirus/workit/tree/main/docs/guides) for verification, delivery, grants and
configuration.
