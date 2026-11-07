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

- `@brainervirus/workit-core`
- `@brainervirus/workit-mcp`
- `@brainervirus/workit-cli`
- `@brainervirus/workit-opencode`
- `@brainervirus/workit-cursor`
- `@brainervirus/workit-codex`
- `@brainervirus/workit-pi`
- `@brainervirus/workit-claude-code`

Then set each package's Publishing access to require 2FA and disallow
tokens, and delete the `NPMJS` repository secret and its npm token. npm also
checks that `repository.url` in each `package.json` names this repo:
`git+https://github.com/BrainerVirus/workit.git`, with `directory` set to
`packages/<pkg>` (`test/artifacts/release-orchestration.test.ts` pins it).

Trusted publishing cannot create a package. A new `@brainervirus` name must be
published once by hand (`npm publish --access public` from its tag, logged in
with 2FA) before its trusted publisher can be added.

### Tags that were cut but not published

When the publish step fails, the tag and GitHub release stay, but the npm
versions never appear (v14.5.0 to v14.5.4 failed on a rejected token). Never
delete or move those tags: the next release takes the next version and
publishes it.

The publish step diffs against the previous tag, not against what npm has. A
package whose only changes landed in the unpublished tags is skipped by the
next release (unless a package that installs it ships), so npm keeps serving
its old version. After the next release, compare each package:

```bash
npm view @brainervirus/<pkg> version   # last version on npm
git diff --name-only v<that version>..v<next release> -- packages/<pkg>
```

If the diff is not empty, ship it with a follow-up PR that changes something
under `packages/<pkg>/` (a patch release publishes it), or publish it by hand
from the release tag with 2FA, in dependency order (see above).

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

## The 14.x bridge (release/14.x)

`release/14.x` carries the last releases on the old `@brainervirus/workit-*`
scope. Its `release.config.cjs` releases from `release/14.x` only, keeps the
default `v${version}` tags, refuses any version outside 14.x
(`verifyReleaseCmd`), and publishes all 8 packages
(`publish-changed-packages.ts --all`, or `PUBLISH_ALL=1`): every old package's
`latest` must carry the migrating `workit upgrade`. `ci.yml` runs on pushes to
`release/14.x` and its `release` job runs there too. Never merge main into it.
