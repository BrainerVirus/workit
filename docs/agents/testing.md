# Testing

Read before running anything beyond `bun run test`, or before adding a suite
that packs, installs or needs docker.

## Node 24+

Tests spawn the real `node` on PATH for packed adapters, doctor and
installers. `test/shared/node-guard.ts` (a `bunfig.toml` preload) exits before
any test runs when that `node` is older than the support-matrix minimum
(24); switch with `fnm use` (reads `.node-version`).

## Local pins

When a live host (Claude Code `--plugin-dir`, OpenCode `file://` pin, Pi local
install) loads a checkout, never run root `bun run build` or `bun run check` in
it: they replace bundles the host has loaded. Run lint, format, typecheck and
tests directly, or work in a separate worktree.

## Tiers

`bun scripts/test.ts <unit|packaging> [bun test args]` selects a tier; the
`PACKAGING` list in `scripts/test.ts` defines the split. Plain `bun test`
runs everything; `bun test <path>` runs one file.

- `bun run test`: the unit tier, everything not in `PACKAGING`, including
  `test/acceptance/` (`bun run test:acceptance` runs just
  `test/acceptance/deterministic.test.ts`).
- `bun run test:packaging` (slow): packs tarballs, runs npm and Pi installs and
  drives doctor against installed artifacts. Packing builds each adapter into
  a sandbox first (`packWorkspacePackages` in
  `test/shared/helpers/packages.ts`), so neither tier needs `bun run build`
  first.

## Opt-in suites

- OpenCode v2 docker suites (`test/opencode-v2/contract|lifecycle|matrix`) sit
  in the packaging tier but report as skipped unless `WORKIT_V2_HARNESS=1` is
  set and docker is available. CI runs them only on demand or with the
  `opencode-v2` PR label (`.github/workflows/opencode-v2-harness.yml`).
- Claude Code plugin evals run nightly, on demand or with the `eval` PR label
  (`.github/workflows/claude-eval.yml`).

## CI-only checks

CI also runs `bun run knip` (unused files/exports and reachability),
`bun run doctor` (react-doctor on the CLI UI), actionlint and zizmor, which
`bun run check` does not, and lints the PR title with commitlint. Run knip after deleting or moving exports.
