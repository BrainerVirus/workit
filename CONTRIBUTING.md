# Contributing to workit

Thanks for contributing. `@brainervirus/workit` is the public npm name of the `workit` repo: workflow rails for agentic coding (specs, plans, YouTrack, CI-gated commits).

## Install from source

```bash
bun i
```

Then load the plugin from a local path in your OpenCode config (`~/.config/opencode/opencode.json`) or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/workit/packages/workit-opencode/src/plugin.ts"]
}
```

## Checks

```bash
bun run check          # build + lint + format:check + bun test + tsc --noEmit
bun run hooks:install  # optional, once per clone: lefthook git hooks
```

Always run `bun run check` before opening a PR. The opt-in hooks format and lint
staged files on `pre-commit` (under a second) and run commitlint on
`commit-msg`; semantic-release reads Conventional Commits, so a malformed
message changes release behavior. Hooks are shared by every worktree of a clone.

## Branch policy

- Every change lives on a `feature/<slug>` branch (bugfixes: `bugfix/<slug>`) cut from `main`.
- `main` is the trunk; open a PR to `main` when the work is ready for review.
- The spec/plan contract is enforced for tracked work: `docs/<slug>/spec.md` declares the branch and `docs/<slug>/plan.md` links it.

## Review flow

1. Open a PR to `main` with a concise conventional-commit description (`feat(...)`, `fix(...)`, `chore(...)`).
2. CI (fast static gates, every test suite on Linux, core + artifacts on macOS/Windows) must be green.
3. The OpenCode review check runs on the PR — it must be green (see the README [Code review](https://github.com/BrainerVirus/workit#code-review) section).
4. A push to `main` that passes CI runs semantic-release from the same CI run: it versions from Conventional Commits and publishes the changed `@brainervirus/workit-*` packages with npm provenance.
