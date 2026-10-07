# Core, hosts and adapters

Read before touching a host adapter (`packages/workit-<host>/`), hooks,
setup or upgrade, grants, agent-facing tool schemas, or YouTrack code. The
rules for that code (core vs adapters, never fabricate, lenient readers,
hooks fail open, migrations, grants) are in
[CODING_STANDARDS.md](../../CODING_STANDARDS.md).

## Checks that enforce the rest

These rules are guarded by tests; the failure names what to fix.

- Agent-facing tool schemas stay flat (depth 1): add fields in
  `packages/workit-core/src/core/operation-input.ts`, not nested objects.
  Guard: `test/workit-mcp/server.test.ts`.
- The Cursor MCP launcher shape (`npx -y --prefer-online
  --min-release-age=0 --package=@brainervirus/workit-cursor@latest …`, see
  npm/cli#9765) and the hook launcher (`node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" <bin>`,
  pinned, `failClosed: false`, never `@latest`) are defined in
  `packages/workit-cli/src/admin/registration.ts` and checked by the doctor,
  `test/artifacts/manifests.test.ts`, `test/artifacts/registration.test.ts`
  and `test/workit-cursor/hook-launcher.test.ts`.
- YouTrack hosts, issue ids and timezones come from `youtrack.json`;
  `test/workit-core/youtrack-work-date.test.ts` scans shipped source for them.

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
