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
  "plugin": ["file:///path/to/workit/packages/workit/src/plugin.ts"]
}
```

## Checks

```bash
bun run check    # bun test + tsc --noEmit
```

Always run it before committing; CI runs the same command on push/PR.

## Branch policy

- Every change lives on a `feature/<slug>` branch (bugfixes: `bugfix/<slug>`) cut from `main`.
- `main` is the trunk; open a PR to `main` when the work is ready for review.
- The spec/plan contract is enforced for tracked work: `docs/<slug>/spec.md` declares the branch and `docs/<slug>/plan.md` links it. Run `workflow_docs_validate` on the spec/plan pair before handoff.

## Review flow

1. Open a PR to `main` with a concise conventional-commit description (`feat(...)`, `fix(...)`, `chore(...)`).
2. CI runs `bun run check` on the PR — it must be green.
3. The OpenCode review check runs on the PR — it must be green (see the README [Code review](https://github.com/BrainerVirus/workit#code-review) section).
4. Pushes to `main` trigger semantic-release: it versions from Conventional Commits and publishes `@brainervirus/workit` + `@brainervirus/workit-cli`.
