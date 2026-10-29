# Release and qualification

Read before anything that touches versions, tags, the release workflow,
release qualification, branch names or commit messages.

## How a release happens

A push to `main` that passes CI calls the release workflow (semantic-release).
`packages/workit-core/scripts/analyze-release-scope.ts` picks the bump from
Conventional Commits, and only when a package's published payload changed:
anything under its `packages/<pkg>/` dir or the sources it bundles. A `docs:`
or `chore:` change there still ships as a patch. Root docs, tests and tooling
never release, and only changed packages are published.

Never edit versions or tags by hand. Because PRs are squash-merged, the PR
title is the commit semantic-release reads. A breaking change needs `!` in the
PR title (`fix!: …`); a `BREAKING CHANGE:` footer only counts if it lands in
the squash body.

Release notes have a section for every type that can trigger a release (feat,
fix, perf, revert, refactor, docs, test, build, ci, chore), so a refactor-only
release still lists its commit. `style` and the `chore(release)` manifest-sync
commits stay out (`presetConfig.types` in `release.config.cjs`).

The GitHub release (tag, notes) is created before npm publishing, so a
publish failure can no longer leave a tag without a release. For each changed
package, `publish-changed-packages.ts` checks a failed `npm publish` against
the registry (`npm view <name>@<version> version`). A version already there
counts as published. Otherwise it retries once, in a new process, which covers
transient errors such as sigstore's `TLOG_CREATE_ENTRY_ERROR` (409). A package
that still fails makes the job fail with a summary after the others are
published. Re-publish it by hand from the tag.

Releases that went out header-only or without a GitHub release can be repaired
with `bun scripts/backfill-release-notes.ts <from-tag>..<to-tag>`. It
regenerates the notes with the release config and prints what it would change.
Add `--apply` to edit header-only releases and create missing ones (never
marked latest). It needs `gh` authenticated with write access to the repo.

When the manifest-sync PR is still open on a later main push, the release job
updates its branch if GitHub reports it `BEHIND`. A failed update never fails
the release.

`bun run verify:release-candidate` checks the release candidate (CI runs it);
`bun run validate:cursor-marketplace` checks the Cursor marketplace manifest.

Adapter bundles inline workit-core (and the CLI/MCP sources) at build time.
`packages/workit-core/scripts/verify-bundle-sources.ts` fails the release when a
bundle inlined a registry copy from `packages/*/node_modules/@brainervirus`
instead of the tagged source; the release job sets
`NPM_CONFIG_WORKSPACES_UPDATE=false` so `npm version` never installs one.

## Qualification

Live release qualification (`docs/qualification/qualification.md`) needs
explicit authorization: never run `scripts/run-v1-evaluation.ts` or fabricate
batch results without it.

## Branches and commits

Branch prefixes: `feature/`, `bugfix/`, `chore/`, `docs/`, `ci/`. Commit
messages are linted by commitlint once you run `bun run hooks:install`; CI
lints the PR title (`.github/workflows/pr-title.yml`).
