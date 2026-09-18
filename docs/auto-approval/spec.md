# Workit Auto-Approval — Definition (audit + scope)

## 1. Goal

A human-free implementation loop on capable hosts: once a task is started
and its direction is settled, branch creation, commits, push, PR creation,
and merge proceed with zero approval questions. Auditability goes UP, not
down: every effect runs through the attributed path (reservation, exact
descriptor binding, reconciliation evidence) instead of unattested shell.

Approved scope (stated design decision 2026-09-18): full auto-approval for
branch, commits, push, PR, and merge, with protected-target blocks, push
identity check, and no unattended publish as code.

## 2. Audit basis

- Gate inventory: 23 gates traced across `authority.ts`,
  `external-action*.ts`, the OpenCode adapter, and the workflow contract.
  Happy-path cost today is 4 human questions (design, branch, chain, push);
  PR folds into the chain, merge has no workit route, close is question-free.
- Host parity: the headless-satisfiable set is identical everywhere
  (`context.read`, reads/`--preview`, `stated` non-mutating choices, chain
  replay under a valid lease). Cursor/Codex can never mint mutating approvals
  in-host by design; auto-approval must be a core policy concept, never a
  per-host bypass. Anything fabricating receipts or simulating TTY breaks the
  contract on every host at once.
- Blast radius: approvals constrain the attributed path, not capability.
  File writes are host-policy ungated; `gh pr merge`, `git push origin
  main`, and `npm publish` pass raw shell silently today. The push route has
  no protected-branch check and the push identity rule is prose, not code.

## 3. What goes automatic

| Effect | Today | Under auto-approval |
|---|---|---|
| `git.branch_setup` (non-protected targets) | 1 question | automatic under task scope; records reservation as now |
| `git.commit` (listed or single) | 1 question or plan-list slot | automatic; consents exactly as the chain does today |
| `git.push` to the task branch | 1 question, no target check | automatic to the task branch only (see §4) |
| `hosting.pull_request` | 1 question or terminal chain step | automatic; babysit still drives to merge-ready |
| PR merge | no workit route (raw shell) | a real gated-then-automatic route honoring branch protections |
| `pre-pr-cleanup` (deslop) | evidence or waiver | unchanged: still requires the deslop pass or waiver |
| Design/product choices | receipt-shaped question | UNCHANGED: still human-gated, first occurrence only |
| `task.close` outcome | requirements gate | UNCHANGED |

## 4. Hard guardrails (code, not prose)

1. Protected-target blocks: push, PR-target, and merge-target resolve
   against branch policy; protected refs fail closed, never ask.
2. Push identity check as code: compare `gh api user` login against the
   checkout's area account at push time; mismatch fails closed.
3. No unattended publish: `npm publish`, `gh release create`, and tag pushes
   stay gated (no workit route exists; raw shell stays out of scope).
4. Plan-before-mutation stays: auto-approval never fires without an active
   task whose scope covers the paths; pre-existing-branch and dirty-tree
   semantics unchanged.
5. Standing-rule persistence: each auto-approved class records one scoped
   standing rule per task (never re-receipt); revoking the rule restores
   questions immediately.

## 5. Non-goals

- Removing human approval for product/design decisions, limitation waivers,
  or close outcomes.
- Per-host bypasses, simulated TTY, fabricated receipts, or new receipt
  types. Cursor/Codex headless behavior is unchanged.
- Silent behavior change for existing installs: auto-approval is opt-in per
  workspace (default off), recorded as a standing rule.

## 6. Acceptance for the implementation follow-up

- Zero questions on a standard implement→commit→PR→merge run with
  auto-approval on; every effect still carries reservation + exact binding.
- Protected push/PR-target/merge-target attempts fail closed with a reason.
- Publish/release attempts still require a human.
- Parity tests prove identical outcomes across OpenCode, Pi, and CLI.
- Docs (README), AGENTS.md, and CHANGELOG Unreleased updated in the same
  change.
