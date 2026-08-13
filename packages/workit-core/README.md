# @brainervirus/workit-core

Shared core for the workit plugins — the single source of workflow logic that the OpenCode, Cursor, and CLI packages adapt to their native surfaces.

## When you need it directly

End users do **not** install this package directly — install `@brainervirus/workit-cli` (wizard) or the platform plugin (`@brainervirus/workit-opencode`, `@brainervirus/workit-cursor`). The adapters pull core in as a dependency and ship it with their bundles.

You consume `@brainervirus/workit-core` directly only when:

- Building a new host adapter (e.g. a future `codex/` adapter) that maps a host's native surfaces to the shared `src/core/` logic.
- Reading the canonical source of workflow behavior: specs/plans, approval flow, commit/PR, changelog, YouTrack, presentation, doctor, and diagnostics.

## Layout and ownership

| Path | Contents |
| --- | --- |
| `src/core/` | Shared TS logic (setup, registration, doctor, logger, branch, PR, changelog, YouTrack, presentation, docs, SDD, support matrix). |
| `src/core.ts` | Package entry; adapters import `@brainervirus/workit-core/src/*`. |
| `skills/` | 12 OpenCode-native `wk-*` skills. |
| `commands/` | 12 OpenCode `wk-*` command prompts. |
| `scripts/` | Shared shell installers/launchers and the release-time workspace-dep rewrite. |
| `templates/` | Execution and Superpowers contract templates. |
| `vendor/superpowers/skills/` | 14 vendored Superpowers skills. |

Adapters map host-native surfaces to `src/core/`; they never re-implement core logic. Keep shared behavior here and host-specific presentation in each adapter.

## Exports

- Main entry: `./src/core.ts`.
- Subpath exports: `./src/*.ts` (e.g. `@brainervirus/workit-core/src/core/doctor`), plus `./package.json`.

## Package scripts

```bash
bun run typecheck   # tsc --noEmit
```

Core has no build step — the adapters bundle it at build time. See the root [README](../../README.md) for the full development, CI, and versioning notes.
