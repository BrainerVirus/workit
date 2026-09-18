# Workit Auto-Approval — Plan

Implements `docs/auto-approval/spec.md` (approved scope + 5 guardrails).
Rule of the run: one plan approval covers the listed commits; each commit
executes once, in order; verification, review, PR, and close follow.

## Mechanism (core concept, not per-host bypass)

A workspace opts in via `workspaces.json`: `autoApprove` (list of action
classes among `branch`, `commit`, `push`, `pr`, `merge`, or `true`) plus
`vcs.account` (required for push). Default off (absent).

At reserve time, core resolves a **standing approval** from live workspace
config (never cached; removing the flag restores questions immediately):
scope = workspace + action classes, revocation = the live config itself.
It satisfies the receipt requirement in place of a one-shot native receipt.
Every auto action still gets reservation, exact descriptor binding, single
consumption, and reconciliation evidence — the audit trail is per action,
only the human question is gone. Plan-before-mutation stays: auto fires
only with an active task whose scope covers the paths.

## Task sequence

### Task 1: Core standing-rule policy
- `WorkspaceConfig` gains `autoApprove` + `vcs.account` (typed, optional).
- `autoApproves(root, operationClass)` resolver; unknown classes never match.
- Standing approval satisfies reserve in place of a receipt; consumption
  recorded per action against the rule.
- Tests: RED opt-in matrix (absent/off/partial/full), revocation,
  unknown-class rejection.
- Commit: `feat(core): workspace auto-approval standing rule`

### Task 2: Guardrails as code
- Protected-target check on push, PR-target, and merge-target via branch
  policy (preset + workspace list); protected refs fail closed, never ask.
- Push identity: `gh api user` / `glab api user` login vs `vcs.account`;
  mismatch or absent account under auto mode fails closed.
- Tests: RED protected push/PR/merge refusals, identity match/mismatch/
  absent, non-auto paths unchanged.
- Commit: `fix(gates): protected targets and push identity as code`

### Task 3: Merge route
- New `hosting.merge` external action: squash + delete branch per
  `vcs.json` `pr` settings, protected-target check, exact descriptor
  binding like `hosting.pull_request`. No chain-alphabet change.
- Tests: RED merge resolve/execute, protection refusal, settings honored.
- Commit: `feat(actions): hosting.merge route with protections`

### Task 4: Adapter auto-resolution with parity
- OpenCode, Pi, CLI: when the standing rule covers the operation and
  guardrails pass, skip the native question/TTY confirm, record the auto
  observation, execute under reservation. Cursor/Codex behavior unchanged
  (cannot mint; routes through CLI surface as today).
- Tests: RED parity — identical outcomes on OpenCode, Pi, CLI for each
  auto class; revocation restores questions; guardrail failures stay closed.
- Commit: `feat(adapters): auto-approval resolution with parity tests`

### Task 5: Docs and deslop
- `AGENTS.md` auto-approval bullets, `README.md` usage, `CHANGELOG.md`
  Unreleased entries. Deslop pass with evidence.
- Commit: `docs(contract): auto-approval behavior and changelog`

### Task 6: Verification and delivery
- Full `bun run check`, fresh-context review via one bounded reviewer,
  PR through `hosting.pull_request`, babysit to merge-ready, re-record
  evidence post-merge, close.

## Commit list (one atomic commit per task)

1. `feat(core): workspace auto-approval standing rule`
2. `fix(gates): protected targets and push identity as code`
3. `feat(actions): hosting.merge route with protections`
4. `feat(adapters): auto-approval resolution with parity tests`
5. `docs(contract): auto-approval behavior and changelog`
6. Verification evidence only; no separate commit.
