# Agent contract (workit repository)

How to work **on** this repository. It does not reach installed Workit
projects: rules for agents there ship in a package (see
[docs/agents/agent-rules.md](docs/agents/agent-rules.md)).

## Commands

Bun for development. Tests need Node.js 24+ on PATH (a preload stops the run
otherwise); `fnm use` picks it up from `.node-version`.

```bash
bun run check         # build + lint + format:check + both test tiers + tsc
bun run lint          # oxlint
bun run format:check  # oxfmt; `bun run format` fixes (Markdown is not formatted)
bun run typecheck     # tsc --noEmit
bun run test          # unit tier; `bun test <path>` runs one file
```

**Local-pin caveat.** When a live host (Claude Code `--plugin-dir`, OpenCode
`file://` pin, Pi local install) loads this checkout, never run root
`bun run build` or `bun run check` in it: they replace bundles the host has
loaded. Run lint, format, typecheck and tests directly, or work in a separate
worktree.

## Workflow

- One git worktree per change, on a branch cut from `origin/main`:
  `git worktree add -b feature/<slug> ../workit-wt/<slug> origin/main`.
  Never commit on `main`. Prefixes: `feature/`, `bugfix/`, `chore/`, `docs/`,
  `ci/`.
- PRs are squash-merged and the PR title becomes the release note and drives
  the version, so it must be a valid Conventional Commit (`feat(cli): …`,
  `fix!: …`). Commit messages are checked by commitlint once you run
  `bun run hooks:install`.
- Before any GitHub remote mutation, confirm the identity with
  `gh api user --jq .login`; `gh auth status` can disagree with the credential
  actually used.
- A session that did not author the change reviews it.
- Update the README or the relevant guide in the same PR as user-facing
  behavior.

## Code

Core logic lives in `packages/workit-core/src/`; host adapters only map
host-native surfaces onto it. A feature reaches every host it applies to plus
the CLI. Never fabricate authority, receipts or identity a host cannot observe.

## Read before

- Running the packaging, acceptance or CI-only suites:
  [docs/agents/testing.md](docs/agents/testing.md).
- Touching an adapter, hooks, setup/upgrade, grants, tool schemas or YouTrack:
  [docs/agents/hosts.md](docs/agents/hosts.md).
- Editing a skill, the bootstrap, or adding a rule for installed projects:
  [docs/agents/agent-rules.md](docs/agents/agent-rules.md).
- Anything about versions, release or qualification:
  [docs/agents/release.md](docs/agents/release.md).
