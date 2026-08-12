# Agent Contract

Multi-platform workit: OpenCode, Cursor, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature | OpenCode | Cursor | CLI |
| --- | --- | --- | --- |
| Approval | native `question` tool receipts | AskQuestion policy-only (`attested: false`) | `--confirm` flags / TTY prompts |
| Handoff | spawns a native OpenCode session | seeds a handoff prompt for the next agent | prints a handoff summary |
| Tools | native plugin tools | MCP server (`workflow_*`) | `workit` commands |
| Skills | `skills.paths` + vendored dirs | plugin `skills/` dirs | n/a |
| Branch policy init | `workflow_toolkit_init_apply action=branch_policy` | same MCP tool | wizard screen |

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.

## Workflow contract

- Specs/plans live in `docs/<slug>/`; spec+plan are committed, `sdd/` is gitignored.
- Approval evidence: OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity).
- Never use worktrees; use guarded in-place branch setup.
