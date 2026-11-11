# Agent contract (workit repository)

How to work **on** Workit, a Bun monorepo: one workflow core plus host adapters and a CLI.
It does not reach installed projects; see [docs/agents/agent-rules.md](docs/agents/agent-rules.md).

## Commands

```bash
bun run check   # build + lint + format:check + both test tiers + tsc
bun run lint; bun run format:check; bun run typecheck; bun run test  # one gate each
bun test <path> # one file; `bun run format` (oxfmt, never prettier) fixes formatting (not Markdown)
```

`bun run lint` also runs the repo rules (`scripts/repo-rules/`): a new hit fails naming its fix; after
fixing a baselined one, `bun run lint:rules --write` shrinks the baseline.

Tests need Node 24+ on PATH (`fnm use` reads `.node-version`). Never run root `build` or `check` in
a checkout a live host has loaded; see [testing.md](docs/agents/testing.md#local-pins). Hosts run
the released npm packages; to prove a change in a real host, point it at a worktree only for the
test and switch back ([real-host tests](docs/agents/testing.md#real-host-tests)).

## Workflow

- One worktree per change, never on `main` and never next to the checkout: `git worktree add -b feature/<slug> ~/.local/state/workit/worktrees/workit/<slug> origin/main` (`workit fanout worktree create` uses the same root); `workit gc --worktrees --apply` removes merged ones, old `~/.cache/workit-wt` ones included.
- The squash-merged PR title is the release note and picks the version: a Conventional Commit (CI lints it).
- Check `gh api user --jq .login` before a GitHub remote mutation; `gh auth status` can disagree.
- Host parity: a feature ships for all five hosts (Claude Code, OpenCode, Codex, Cursor, Pi) through each host's native mechanism, or records the host limit in [hosts.md](docs/agents/hosts.md#host-parity).
- Report verification through `workit check <name>`; a non-author session reviews. User-facing behavior updates the README or guide in the same PR.

## Read before

- Writing or reviewing code: [CODING_STANDARDS.md](CODING_STANDARDS.md).
- Packaging, acceptance or CI-only suites: [docs/agents/testing.md](docs/agents/testing.md).
- Weak-model parity, the local eval bench and its cases: [docs/agents/eval.md](docs/agents/eval.md).
- Adapters, hooks, setup, grants, tool schemas, YouTrack: [docs/agents/hosts.md](docs/agents/hosts.md).
- Files Workit keeps outside a repo (config, state, data, cache dirs): [docs/agents/file-locations.md](docs/agents/file-locations.md).
- Skills, the bootstrap, rules for installed projects: [docs/agents/agent-rules.md](docs/agents/agent-rules.md).
- Versions, release, qualification, branch prefixes: [docs/agents/release.md](docs/agents/release.md).
