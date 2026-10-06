<!-- PR title = squash commit subject: a Conventional Commit, e.g. `feat(cli): add stack land --max`. Add `!` for breaking changes. -->

## What and why

<!-- What changes, and the problem it solves. Link the issue, spec or plan (docs/…) if there is one. -->

## Scenarios covered

<!-- Given / When / Then for the behavior this PR adds or changes, and where each is tested. -->

- Given …, when …, then … (`test/…`)

## Verification

<!-- Evidence, not claims. Paste `workit check` results or command output. -->

- [ ] `bun run lint`, `bun run format:check`, `bun run typecheck`
- [ ] `bun run test` (and `bun run test:packaging` if packaging, install or doctor code changed)
- [ ] Exercised on the affected host(s) or CLI:

```text
workit check …
```

## Breaking changes

<!-- None, or what breaks and how users migrate (also add `!` / a BREAKING CHANGE footer). -->

None.

## Checklist

- [ ] README / `docs/guides/` updated for user-facing changes
- [ ] Host differences are explicit (a host that cannot observe something says so)
- [ ] Existing user config, pins and grants are preserved
