# Release and qualification

Read before anything that touches versions, tags, the release workflow or
release qualification.

## How a release happens

A push to `main` that passes CI calls the release workflow (semantic-release).
`packages/workit-core/scripts/analyze-release-scope.ts` picks the bump from
Conventional Commits, and only when a package's published payload changed:
anything under its `packages/<pkg>/` dir or the sources it bundles. A `docs:`
or `chore:` change there still ships as a patch. Root docs, tests and tooling
never release, and only changed packages are published.

Never edit versions or tags by hand. Because PRs are squash-merged, the PR
title is the commit semantic-release reads.

`bun run verify:release-candidate` checks the release candidate (CI runs it);
`bun run validate:cursor-marketplace` checks the Cursor marketplace manifest.

## Qualification

Live release qualification (`docs/qualification/qualification.md`) needs
explicit authorization: never run `scripts/run-v1-evaluation.ts` or fabricate
batch results without it.

`docs/qualification/capabilities.md` is the output of
`renderCapabilitiesMarkdown(collectCapabilityMatrix())` in
`test/acceptance/harness.ts`; `test/acceptance/deterministic.test.ts` (in the
unit tier and `bun run test:acceptance`) fails when the committed file
differs. No script writes it, so regenerate it from that function.
