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
