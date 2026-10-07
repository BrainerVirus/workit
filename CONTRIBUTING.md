# Contributing to Workit

Thanks for helping. Workit is a Bun monorepo; published packages run on
Node.js 24+. The full development contract is [AGENTS.md](AGENTS.md) (commands
and workflow), the topic files it points to in [`docs/agents/`](docs/agents/)
(testing, hosts, release) and [CODING_STANDARDS.md](CODING_STANDARDS.md);
this page is the short version.

## Set up

```bash
git clone https://github.com/BrainerVirus/workit.git
cd workit
bun install --frozen-lockfile
bun run hooks:install   # optional: format/lint on commit, commitlint on commit-msg
```

To try your changes in a host, pin it to your checkout (see the
[Claude Code](docs/guides/claude-code.md) and [hosts](docs/guides/hosts.md)
guides). While a host has the checkout loaded, do not run root `bun run build`
or `bun run check` in it; use a separate worktree.

## Make a change

1. Branch from `origin/main`, ideally in its own worktree:
   `git worktree add -b feature/<slug> ../workit-wt/<slug> origin/main`.
2. Keep the change small and focused. For larger work, open an issue first;
   a short spec or plan under `docs/` helps when the change spans several PRs.
3. Write tests for behavior (Given/When/Then is a good shape) and update the
   README or the relevant guide when user-facing behavior changes.
4. Verify:

   ```bash
   bun run lint && bun run format:check && bun run typecheck
   bun run test              # unit tier
   bun run test:packaging    # if you touched packaging, install or doctor code
   ```

   If you use Workit while developing, `workit check <name>` records the run
   as evidence you can cite in the PR.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat`,
  `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, with an optional scope
  (`feat(cli): …`). Mark breaking changes with `!` or a `BREAKING CHANGE:`
  footer.
- PRs are squash-merged and **the PR title becomes the commit subject**, which
  drives the release version. Keep it a valid conventional commit.
- Fill in the PR template: what and why, scenarios covered, verification
  evidence, breaking notes.
- CI (lint, format, knip, typecheck, both test tiers on Linux; core and
  artifacts on macOS and Windows) must be green. A different person or session
  than the author reviews.

Releases are automatic: semantic-release publishes from `main` when product
paths changed.

## Reporting bugs and security issues

Use the [issue forms](https://github.com/BrainerVirus/workit/issues/new/choose)
and include `workit doctor --json` output. Please do not report security
vulnerabilities in public issues; contact the maintainer
([@BrainerVirus](https://github.com/BrainerVirus)) privately first.
