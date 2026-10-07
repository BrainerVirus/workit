# Core, hosts and adapters

Read before touching a host adapter (`packages/workit-<host>/`), hooks,
setup or upgrade, grants, agent-facing tool schemas, or YouTrack code.

## Core and adapters

- Core logic lives in `packages/workit-core/src/`. Adapters (`workit-claude-code`,
  `workit-opencode`, `workit-cursor`, `workit-codex`, `workit-pi`, the shared MCP
  transport `workit-mcp`, and the CLI in `workit-cli`) only map host-native
  surfaces onto it. Never re-implement core logic per host.
- A feature reaches every host it applies to plus the CLI, with tests showing
  the same outcome on each. Where a host cannot observe something, report it as
  `agent_guided`; never fabricate authority, receipts or identity.

## Hooks and gates

- Hooks fail open and never answer `allow`; host permissions stay
  authoritative.
- The before-write gate gates working-tree edits only, never Workit's own
  commands, history moves or the paths that unblock it.

## Setup, upgrade and grants

- Keep config migrations idempotent and back up before applying. Preserve
  unknown fields, credentials, exact/local pins and narrower workspace
  overrides. Never migrate task history through setup or weaken host
  permissions.
- Grants (and the `verification` mode) are read only from the user's
  `workspaces.json`; no repository file, MCP tool or host tool may raise them.

## Checks that enforce the rest

These rules are guarded by tests; the failure names what to fix.

- Agent-facing tool schemas stay flat (depth 1): add fields in
  `packages/workit-core/src/core/operation-input.ts`, not nested objects.
  Guard: `test/workit-mcp/server.test.ts`.
- The Cursor runtime launcher shape (`npx -y --prefer-online
  --min-release-age=0 --package=@brainervirus/workit-cursor@latest …`, see
  npm/cli#9765) is defined in `packages/workit-cli/src/admin/registration.ts`
  and checked by the doctor and `test/workit-core/install-scripts.test.ts`.
- YouTrack: hosts, issue ids, people, greetings and timezones come from
  `youtrack.json` and the `issue-update` template, never from core or tests.
  `test/workit-core/youtrack-work-date.test.ts` scans shipped source for hosts,
  issue ids and timezones; people and greetings are not scanned.

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
