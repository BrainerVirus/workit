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

Releases are tagged `workit-dev-v<version>` (`tagFormat` in
`release.config.cjs`; the scripts share `TAG_PREFIX` from
`analyze-release-scope.ts`). The packages published as `@brainervirus/workit-*`
up to 14.x, tagged `v<version>`; they moved to `@workit-dev/*` and restarted
at 1.0.0. semantic-release reads only tags that match `tagFormat`, so the old
`v*` tags never seed a version. A 14.x maintenance release of the old scope
comes from its own branch with its own config, never from `main`.

Never edit versions or tags by hand. Because PRs are squash-merged, the PR
title is the commit semantic-release reads. A breaking change needs `!` in the
PR title (`fix!: …`); a `BREAKING CHANGE:` footer only counts if it lands in
the squash body.

Release notes have a section for every type that can trigger a release (feat,
fix, perf, revert, refactor, docs, test, build, ci, chore), so a refactor-only
release still lists its commit. `style` and the old `chore(release)`
manifest-sync commits stay out (`presetConfig.types` in `release.config.cjs`).

GitHub rejects a release body over 125000 characters, so
`scripts/clean-release-notes.cjs` caps it. The first release (no previous
`workit-dev-v*` tag) would list every commit in the repository, so its body
only says it continues `@brainervirus/workit` 14.6.1 and links `CHANGELOG.md`
and the migration guide. Any other body estimated over 100000 characters keeps
the entries that fit and ends with a link to the full compare view.

The GitHub release (tag, notes) is created before npm publishing, so a
publish failure can no longer leave a tag without a release. Packages are
published in dependency order. Each one goes after every `@workit-dev`
package it installs, and `workit-cli` goes last, so
`npx @workit-dev/cli@latest upgrade` never resolves a CLI whose host
packages are not on the registry yet (v13.0.0 hit `ETARGET` for 1m40s). For
each changed package, `publish-changed-packages.ts` checks a failed
`npm publish` against the registry (`npm view <name>@<version> version`). A
version already there counts as published. Otherwise it retries once, in a new
process, which covers transient errors such as sigstore's
`TLOG_CREATE_ENTRY_ERROR` (409). A package that still fails makes the job fail
with a summary after the others are published. Packages that install it are
held back, because their `^X` range could not resolve, and so is `workit-cli`
after any failed package. Re-publish them by hand from the tag, in the same
order.

A finished `npm publish` does not make a package visible: npm answers "Your
package is being processed" and can serve it minutes later. In v1.9.1 the
OpenCode package became visible 7 minutes after its publish and 4 minutes
after the CLI, and an upgrade in that window got the previous OpenCode
package. So before it publishes `workit-cli`, the job polls
`npm view <name>@<version> version` every 15 s for every package it published
in this run, for at most 15 minutes. When the bound runs out it publishes the
CLI anyway, with a `::warning::` that names the packages still missing.

Releases that went out header-only or without a GitHub release can be repaired
with `bun scripts/backfill-release-notes.ts <from-tag>..<to-tag>`. It
regenerates the notes with the release config and prints what it would change.
Add `--apply` to edit header-only releases and create missing ones (never
marked latest). It needs `gh` authenticated with write access to the repo.

`bun run verify:release-candidate` checks the release candidate (CI runs it);
`bun run validate:cursor-marketplace` checks the Cursor marketplace manifest.

Adapter bundles inline workit-core (and the CLI/MCP sources) at build time.
`packages/workit-core/scripts/verify-bundle-sources.ts` fails the release when a
bundle inlined a registry copy from `packages/*/node_modules/@workit-dev`
instead of the tagged source; the release job sets
`NPM_CONFIG_WORKSPACES_UPDATE=false` so `npm version` never installs one.

## npm trusted publishing

Releases publish with npm trusted publishing: npm authenticates
`npm publish` through the release job's GitHub Actions OIDC token, so no npm
token exists in the repo or the workflow, and provenance is attached
automatically. The release job installs npm 11.21.1 (Node 24.20.0 bundles
11.19.0; OIDC needs 11.5.1 and `npm dist-tag` over OIDC needs 11.21.0) and
prints `npm --version` before releasing. Both the `release` job in `ci.yml`
and the reusable `release.yml` grant `id-token: write`, and `setup-node` gets
no `registry-url`, whose `_authToken` line would stand in for OIDC.

npmjs.com matches the calling workflow, `ci.yml`, not `release.yml`. Every
package needs this trusted publisher (package page, Settings, Trusted
Publisher, GitHub Actions):

| Field                | Value                |
| -------------------- | -------------------- |
| Organization or user | `BrainerVirus`       |
| Repository           | `workit`             |
| Workflow filename    | `ci.yml`             |
| Environment name     | (empty)              |
| Allowed actions      | publish and dist-tag |

Add it to each of the eight packages:

- `@workit-dev/core`
- `@workit-dev/mcp`
- `@workit-dev/cli`
- `@workit-dev/opencode`
- `@workit-dev/cursor`
- `@workit-dev/codex`
- `@workit-dev/pi`
- `@workit-dev/claude-code`

Then set each package's Publishing access to require 2FA and disallow
tokens, and delete the `NPMJS` repository secret and its npm token. npm also
checks that `repository.url` in each `package.json` names this repo:
`git+https://github.com/BrainerVirus/workit.git`, with `directory` set to
`packages/<pkg>` (`test/artifacts/release-orchestration.test.ts` pins it).

Trusted publishing cannot create a package. A new `@workit-dev` name must be
published once by hand (`npm publish --access public` from its tag, logged in
with 2FA) before its trusted publisher can be added.

### What each release publishes

`publish-changed-packages.ts` diffs each package from the release the
registry serves for it, not from the previous tag: `npm view <name> version`,
then the `workit-dev-v<that version>` tag. A package ships when its payload
changed since that tag, and also when the registry has no version of it, only
the `0.0.1` placeholder that reserved the name, or a version with no local
tag. So a release whose publish failed part-way (v14.5.0 to v14.5.4 failed on
a rejected token) ships the missed packages next time. Never delete or move
those tags.

The first release (no previous `workit-dev-v*` tag: semantic-release renders
`${lastRelease.gitTag}` empty) ships every package. `PUBLISH_ALL=1` or
`--all` ships every package in any release, and `PUBLISH_DRY_RUN=1` runs the
selection without publishing:

```bash
PUBLISH_DRY_RUN=1 bun packages/workit-core/scripts/publish-changed-packages.ts ""
```

## Where the version lives

A release never writes back to `main`, so it adds no commit there and open PRs
do not go `BEHIND` (strict branch protection would make each one rebase and
rerun CI). The release job sets the version in its own checkout and does not
commit it:

1. semantic-release reads the previous release from the `workit-dev-v*` tags,
   not from any manifest, and picks `X`.
2. One `@semantic-release/npm` bumper per package writes `X` into each
   `packages/*/package.json`. They never publish.
3. The prepare step (`rewrite-workspace-deps.ts`) writes `X` into the Codex,
   Cursor and Claude Code `plugin.json` files and turns every internal
   `workspace:*` range into `^X`, then rebuilds the bundles with `X` in them.
4. semantic-release tags `workit-dev-vX` on the merge commit and creates the GitHub
   release.
5. `publish-changed-packages.ts` checks that every package.json, plugin.json
   and internal range says the version of the `workit-dev-v*` tag on HEAD. If any of
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
