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
release still lists its commit. `style` and the old `chore(release)`
manifest-sync commits stay out (`presetConfig.types` in `release.config.cjs`).

The GitHub release (tag, notes) is created before npm publishing, so a
publish failure can no longer leave a tag without a release. Packages are
published in dependency order. Each one goes after every `@brainervirus`
package it installs, and `workit-cli` goes last, so
`npx @brainervirus/workit-cli@latest upgrade` never resolves a CLI whose host
packages are not on the registry yet (v13.0.0 hit `ETARGET` for 1m40s). For
each changed package, `publish-changed-packages.ts` checks a failed
`npm publish` against the registry (`npm view <name>@<version> version`). A
version already there counts as published. Otherwise it retries once, in a new
process, which covers transient errors such as sigstore's
`TLOG_CREATE_ENTRY_ERROR` (409). A package that still fails makes the job fail
with a summary after the others are published. Packages that install it are
held back, because their `^X` range could not resolve. Re-publish them by hand
from the tag, in the same order.

Releases that went out header-only or without a GitHub release can be repaired
with `bun scripts/backfill-release-notes.ts <from-tag>..<to-tag>`. It
regenerates the notes with the release config and prints what it would change.
Add `--apply` to edit header-only releases and create missing ones (never
marked latest). It needs `gh` authenticated with write access to the repo.

`bun run verify:release-candidate` checks the release candidate (CI runs it);
`bun run validate:cursor-marketplace` checks the Cursor marketplace manifest.

Adapter bundles inline workit-core (and the CLI/MCP sources) at build time.
`packages/workit-core/scripts/verify-bundle-sources.ts` fails the release when a
bundle inlined a registry copy from `packages/*/node_modules/@brainervirus`
instead of the tagged source; the release job sets
`NPM_CONFIG_WORKSPACES_UPDATE=false` so `npm version` never installs one.

## Where the version lives

A release never writes back to `main`, so it adds no commit there and open PRs
do not go `BEHIND` (strict branch protection would make each one rebase and
rerun CI). The release job sets the version in its own checkout and does not
commit it:

1. semantic-release reads the previous release from the `v*` tags, not from
   any manifest, and picks `vX`.
2. One `@semantic-release/npm` bumper per package writes `X` into each
   `packages/*/package.json`. They never publish.
3. The prepare step (`rewrite-workspace-deps.ts`) writes `X` into the Codex,
   Cursor and Claude Code `plugin.json` files and turns every internal
   `workspace:*` range into `^X`, then rebuilds the bundles with `X` in them.
4. semantic-release tags `vX` on the merge commit and creates the GitHub
   release.
5. `publish-changed-packages.ts` checks that every package.json, plugin.json
   and internal range says the version of the `v*` tag on HEAD. If any of
   them differs, it stops before publishing anything.

The committed manifests on `main` keep the version of the last sync. Nothing
compares them to a tag. They only have to agree with each other
(`test/artifacts/manifests.test.ts`). To bring them up to date, run
`bun packages/workit-core/scripts/sync-release-manifests.ts` in any PR. Nothing
requires it.

## Qualification

Live release qualification (`docs/qualification/qualification.md`) needs
explicit authorization: never run `scripts/run-v1-evaluation.ts` or fabricate
batch results without it.

## Branches and commits

Branch prefixes: `feature/`, `bugfix/`, `chore/`, `docs/`, `ci/`. Commit
messages are linted by commitlint once you run `bun run hooks:install`; CI
lints the PR title (`.github/workflows/pr-title.yml`).
