# @brainervirus/workit-core

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@brainervirus/workit-core.svg)](https://www.npmjs.com/package/@brainervirus/workit-core)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

The shared core of [Workit](https://github.com/BrainerVirus/workit): task event store, run ledger,
policy, checks, forge and stack logic, host-hook protocol, and the single
source of the eleven method skills. Every host adapter and the CLI bundle it.

End users do not install this package; install the CLI or a host plugin (see
the [root README](https://github.com/BrainerVirus/workit#quickstart)). Use it directly only to build a
new host adapter.

| Path | Contents |
| --- | --- |
| `src/` | Store, ledger, checks, forge, stack, grants, hooks (`src/hooks/`), task/policy engine (`src/core/`) |
| `skills/` | The `workit-*` method skills; adapters ship generated copies |
| `scripts/` | Installers, launchers and release helpers |
| `templates/` | Contract and issue-update templates |

Exports: `./src/core.ts` and `./src/*.ts` subpaths. Setup, doctor, upgrade and
uninstall live in `@brainervirus/workit-cli`. There is no build step; adapters
bundle core. Development: [AGENTS.md](https://github.com/BrainerVirus/workit/blob/main/AGENTS.md).
