# Checkout-Scoped Shell Route Denial - Spec

## Context

The narrow shell route denial (`shellRouteIntent`: `git switch -c/--create`,
`git checkout -b/-B`, `gh pr create`, `glab mr create`) fires globally on every
host with a shell pre-execution boundary. Because the OpenCode plugin is
registered globally, the denial also fires in sessions working in unrelated
checkouts: a manual `git checkout -b` in a non-Workit repository is denied with
`recovery_required` guidance (`use git.branch_setup`) that makes no sense there
(observed in session `ses_f5511cf6cffeR50J3yk4bRjekr`, cwd
`.../sixbell/productos/irp/web/integration`).

The denial is accident prevention, not a security boundary: the recognizer is
deliberately narrow (`git branch <name>`, `git -C <dir> ...`, and unparseable
commands stay unenforced), and PRs observed from unenforced routes are driven
through `workit-babysit`. Scoping the denial to Workit-managed checkouts loses
no protection that matters.

## Goals

- Deny direct branch/PR creation only inside Workit-managed checkouts.
- Allow the same commands silently everywhere else: no warning, no guidance.
- Keep the denial byte-identical where it still applies.
- Keep host parity: OpenCode, Pi, and Codex behave identically; Cursor stays
  unenforced (policy-only host, no blocking shell hook).

## Decisions

- A checkout is Workit-managed iff `<realpath(dir)>/.workit` exists as a
  directory. The marker is written by `TaskStore` on first task write, so it
  means "a Workit task has lived here" (approved decision `5457de50`).
- Core owns the check: a small helper next to `shellRouteIntent` (e.g.
  `isWorkitCheckout(dir)`), unit-tested in core. Adapters only supply the
  directory.
- Each host supplies its session/project directory, already available at every
  deny site: OpenCode session directory (cached per session ID; the directory
  never changes within a session), Pi `ctx.cwd`, Codex hook `cwd`.
- Outside a managed checkout the command is allowed with no diagnostic. A
  warning there would be pure noise: nothing exists to protect.
- A fresh init'd checkout with no task yet does not deny. Accepted: with no
  task in flight the bypass cost is ~zero, and `git.branch_setup` still
  handles pre-existing branches.

## Non-goals

- Command-workdir awareness (bash `workdir` resolution on OpenCode). Deferred
  until a real session-inside/command-outside case appears; Pi cannot supply a
  per-call cwd (`BashToolInput` is command+timeout only), so this would fray
  parity.
- Active-task gating (deny only while a task is active/paused). Rejected: a
  store read on every shell call plus mode-flipping UX is worse than the
  simple managed-checkout rule.
- Recognizer widening (`git branch <name>`, `git -C <dir>`, composed
  pipelines). The narrow recognizer and the unenforced-route babysit doctrine
  stay exactly as they are.
- Cross-repository candidates, writers, or external-action authority.

## Required Behavior

### 1. Core helper

- `isWorkitCheckout(dir: string): boolean`: `realpathSync` the dir (fall back
  to `resolve` when it does not exist, mirroring `sameWorkspace`), return true
  iff `<root>/.workit` exists and is a directory. Never throws: any fs error
  means not managed.
- Unit tests: marker dir present/absent, marker is a file, dangling root,
  relative input. No new dependency.

### 2. Deny sites

- OpenCode `tool.execute.before` (`packages/workit-opencode/src/plugin.ts`):
  after `shellRouteIntent` matches, resolve the session directory (reuse the
  existing `sessionData` lookup, cached per session ID) and skip the denial
  when it is not a managed checkout.
- Pi `enforceNativeWriter` (`packages/workit-pi/src/tools.ts`): skip the
  denial when `ctx.cwd` is not a managed checkout.
- Codex `PreToolUse` (`packages/workit-codex/hooks/workit-hook.ts`): skip the
  denial when hook input `cwd` is not a managed checkout.
- Where the denial still applies, the error text is unchanged.

### 3. Tests

- Core unit tests for the helper (see §1).
- Per-host hook tests: managed checkout denies, unmanaged checkout allows,
  for branch creation and PR creation commands.
- Parity test: identical managed/unmanaged outcomes across OpenCode, Pi, and
  Codex fixtures.

### 4. Docs

- `AGENTS.md`: the branch/PR denial bullet gains an "in Workit-managed
  checkouts" qualifier.
- `CHANGELOG.md` Unreleased entry describing the scoping.
- This spec stays the durable agreement; implementation is a separate
  follow-up task.

## Counter-cases considered

- Fresh checkout, no task yet, agent branches by hand, then starts a task:
  accepted. Nothing existed to protect when the branch was created, and the
  branch_setup flow handles pre-existing branches.
- `git -C <managed> checkout -b` from an unmanaged session: stays allowed, as
  today. Naming it keeps the narrow-recognizer contract honest; widening the
  recognizer is explicitly out of scope.
- Symlinked checkout roots: `realpathSync` before joining `.workit`, same as
  `sameWorkspace`, so symlinked sessions resolve to the same marker.
