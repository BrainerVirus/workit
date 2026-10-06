# @brainervirus/workit-opencode

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainervirus/workit-opencode.svg)](https://www.npmjs.com/package/@brainervirus/workit-opencode)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for OpenCode 2.0.18+: the seven task families,
read-only `workit_context` and `workit_init_apply` as native tools, the
eleven method skills with `/wk-*` commands, direct-child delegation, and
context injection on session start and after compaction. Requires Node.js 24+.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@brainervirus/workit-opencode"]
}
```

Local checkout: run `bun packages/workit-opencode/scripts/build.ts`, then pin
`"file:///path/to/workit/packages/workit-opencode"`. OpenCode 1.x must stay on
`"plugin": ["@brainervirus/workit-opencode@2"]`.

Effects (git, forge, files) run through OpenCode's native tools and the
`workit` CLI under OpenCode permissions plus the workspace
[grants](https://github.com/BrainerVirus/workit/blob/main/docs/guides/grants.md). The permission hook denies direct, unquoted
branch-creation commands that break the naming policy, and edits or
recognizable shell writes while the branch task has an open product choice or
needs a plan ([before-write gate](https://github.com/BrainerVirus/workit/blob/main/docs/guides/verification.md)). Tools take flat
fields. Details:
[hosts guide](https://github.com/BrainerVirus/workit/blob/main/docs/guides/hosts.md#opencode).

```bash
bun run build       # bundle dist/plugin.js (self-contained, no runtime SDK dependency)
bun run typecheck
```
