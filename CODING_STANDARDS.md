# Coding standards

Judgment calls for writing and reviewing code in this repository. Nothing here
is enforced by a check, so a reviewer has to look for it. Rules that a check
enforces are listed at the end only as pointers; the failing check tells you
what to fix.

## Core and adapters

- Core logic lives in `packages/workit-core/src/`. Adapters
  (`workit-claude-code`, `workit-opencode`, `workit-cursor`, `workit-codex`,
  `workit-pi`, the shared MCP transport `workit-mcp`, the CLI in `workit-cli`)
  only map host-native surfaces onto it. Never re-implement core logic per
  host.
- A feature reaches every host it applies to plus the CLI, with tests showing
  the same outcome on each.

## Never fabricate

- Where a host cannot observe something, report it as `agent_guided`. Never
  fabricate authority, receipts, identity or evidence a host cannot observe.
- The trust model guards against honest mistakes and accidental
  self-certification, not adversarial agents. The hard ceilings are host
  permissions, autonomy grants and forge-observed CI; do not build
  anti-adversary machinery beyond them.

## Readers, hooks and config

- Parsers of hook inputs, stored records and config are lenient on unknown
  keys and strict only on required ones, so a newer runtime never bricks an
  older reader (design decision D17, `docs/workit-next/spec.md`).
- Hooks fail open and never answer `allow`; host permissions stay
  authoritative.
- The before-write gate gates working-tree edits only, never Workit's own
  commands, history moves or the paths that unblock it.
- Config migrations are idempotent and back up before applying. They preserve
  unknown fields, credentials, exact/local pins and narrower workspace
  overrides. Never migrate task history through setup or weaken host
  permissions.
- Grants (and the `verification` mode) are read only from the user's
  `workspaces.json`; no repository file, MCP tool or host tool may raise them.
- YouTrack people and greetings come from `youtrack.json` and the
  `issue-update` template, never from core or tests. The YouTrack scanner
  covers hosts, issue ids and timezones, not these.

## Tests

- Test behavior, not implementation. Name tests from Given/When/Then
  acceptance criteria.
- No tautological tests: expected values are independent literals, never
  computed by the code under test. For each test, name the production break
  that should make it fail; if none would, the test is not worth keeping.

## Enforced by checks (pointers only)

- Flat (depth 1) agent-facing tool schemas: `test/workit-mcp/server.test.ts`.
- Cursor runtime launcher shape: `test/workit-core/install-scripts.test.ts`;
  the pinned, fail-open hook launcher: `test/workit-cursor/hook-launcher.test.ts`.
- YouTrack hosts, issue ids and timezones out of shipped source:
  `test/workit-core/youtrack-work-date.test.ts`.
- Generated skill copies and the skill routing list:
  `test/workit-core/generated-copies.test.ts`,
  `test/workit-core/skill-set.test.ts`.
- `docs/qualification/capabilities.md`: `test/acceptance/deterministic.test.ts`
  (regenerate with `bun run write:capabilities`).
- Conventional Commits: commitlint on commit messages (`bun run hooks:install`)
  and on the PR title in CI (`.github/workflows/pr-title.yml`).
- Lint, format, types and unused exports: `bun run check` and `bun run knip`.
