# Workit next (3.0) — spec

Status: approved direction (2026-10-03) · Research: [`research/00-synthesis.md`](research/00-synthesis.md) · Plan: [`plan.md`](plan.md)

## Problem

Workit 2.x makes agents do bookkeeping and makes the user do verification.
In real sessions about 1 in 4 workit calls errored: lock bugs, unbounded recovery copies, a 40 KB
policy schema, hand-built approval bindings. Agents bypassed it in half of the Cursor sessions. Their
"done" claims were wrong whenever someone checked independently. The user ends up as a meat proxy:
saying "continue", restarting sessions, re-typing constraints, checking pushes and CI by hand.

## Goal

The agent decides *what* and *whether*; a deterministic CLI does *how* and records *proof*.
The user stays in the loop for product judgment (shaping, grilling, specs that matter) and stops
relaying or verifying mechanical facts. Work runs in parallel slices that ship as small,
independently verified PRs.

## Decisions (settled in brainstorm round 1)

| # | Decision |
|---|---|
| D1 | **Strangler, not rewrite.** Ship as stacked/sliced PRs on `main`. Stabilization ships first as 2.x patches; breaking model changes land as 3.0 |
| D2 | **Remove the receipt-attested approval chain and the writer lease.** Authority = the host's own permission system + per-workspace **autonomy grants** |
| D3 | **Implicit tasks**, one per branch/worktree (no ids for the agent to manage), stored as an **append-only event log**; no `recovery/` dir |
| D4 | **Default autonomy ceiling**: stack opened, CI green, independently verified. Merge/release needs a workspace grant (e.g. personal: auto-merge allowed; work: never) |
| D5 | **Verification**: author ≠ verifier. A repo-generated `verify-<app>` skill exercises the real surface. Only CLI-observed evidence counts (`workit check -- <cmd>`); claims are labeled measured / inferred / guess. The human answers product and preference questions only |
| D6 | **Durable knowledge by detection**: a spec, plan, ADR or glossary entry is proposed when triggers fire (multi-slice, cross-repo, hard to reverse, open product choice) or when asked; otherwise none. Specs live in repo `docs/`; the run ledger lives in `.workit/` |
| D7 | **Stacking**: built-in, forge-neutral `workit stack` over plain base-branch chains (GitHub + GitLab). `gh stack`/git-spice adapters are optional later. Land only the contiguous verified run from the root |
| D8 | **Host tiers**: Tier 1 = Claude Code (new) + OpenCode. Tier 2 = Codex, Cursor, Pi as thin mappings onto shared `core/hooks`. Retire the OpenCode V1 adapter |
| D9 | **Effect 4** only in the CLI I/O layer (subprocess, lock, retry, typed errors), once stable. The core stays plain TS + zod |
| D10 | **BDD**: acceptance criteria are written Given/When/Then and become test names and seams. Gherkin only where a repo already uses it (e.g. playwright-bdd) |
| D11 | **YouTrack** stays an optional tracker adapter. Remove the greeting, the hard-coded mention and timezone; fix the date bug |
| D12 | **Skills 14 → 10**: `shape`, `implement`, `review`, `debug`, `ship`, `continue`, `bdd`, `test-audit`, `deslop`, `fanout`. Host copies and Cursor commands are generated at build time, not committed |

## Target architecture

```
packages/
  workit-core/         pure domain: model (zod), policy (4 judgments → requirements), eval,
                       store port + append-only FsEventStore, hooks/ (shared host-hook protocol), bootstrap/
  workit-cli/          THE deterministic surface (any host, via shell):
                         task start|status|note|close · check -- <cmd> · git branch|commit|push
                         pr create|status|merge · ci wait|rerun · stack plan|sync|land · verify-delivery
                         ledger · handoff · test-audit · deslop scan · doctor [--fix] · gc · setup · upgrade
  workit-mcp/          thin: exposes the CLI verbs as tools for hosts without a shell
  workit-claude-code/  NEW: .claude-plugin/, skills/ (generated), agents/ (verifier, reviewer, implementer),
                       hooks/hooks.json → core/hooks, optional .mcp.json; local pin + marketplace latest
  workit-opencode/     plugin: hooks + thin tools mapping to CLI verbs
  workit-cursor/ workit-codex/ workit-pi/   thin manifests + field mapping onto core/hooks
skills/ (source)       10 short skills: what + when + trigger words; procedure → `workit …`; each ends on a runnable check
```

Principles:
1. A step with one right answer belongs to the CLI. A mechanical failure that repeats gets a deterministic check.
2. Agent prose is a note, never evidence.
3. Every block prints its own unblock command. Retryable contention says `busy`, never `recovery_required`.
4. Inputs the agent writes stay flat and small. Accept aliases; never require exact headers or labels.
5. Ceremony scales with the work. A two-line fix gets no spec, no plan and no lifecycle.
6. One writer per worktree/branch. Parallel workers get a fixed brief (goal, scope, acceptance, verify, forbidden, report).

## Behavior (acceptance, Given/When/Then)

- **Stale lock**: Given a lock held by a dead pid, When any write runs, Then the lock is reclaimed and the write succeeds.
- **Contention**: Given two live writers, When both write, Then one gets `busy` (retryable) and no `recovery_required` is emitted.
- **Bounded state**: Given 1,000 writes to one task, Then on-disk state grows with the event count, never with full-file copies.
- **Observed evidence**: Given `workit check -- bun test`, When the command exits non-zero, Then failing evidence is recorded with exit code, log digest and HEAD SHA, and a close gate requiring passing tests stays unsatisfied.
- **Self-report rejected**: Given an agent-reported "tests pass" note, Then it does not satisfy a check requirement.
- **PR status**: Given an open PR/MR on GitHub or GitLab, When `workit pr status --json` runs, Then it returns mergeability, behind-base, failing checks with log tails, and unresolved threads.
- **Stack land**: Given a 4-PR stack where PR 1-2 are verified and PR 3 is not, When `workit stack land` runs with a merge grant, Then only PR 1-2 merge, in order, and PR 3 is retargeted.
- **Autonomy**: Given a workspace without a merge grant, When the agent attempts a merge, Then it is denied with the grant needed, and the stack stops at "verified, ready".
- **Implicit task**: Given a fresh branch, When the agent records evidence, Then a task exists for that branch without an explicit start call.
- **Claude Code pin**: Given `claude --plugin-dir packages/workit-claude-code`, Then skills, hooks and the CLI resolve from the checkout. Given the marketplace install, Then they resolve from the latest published package.
- **Durable knowledge**: Given a one-file mechanical fix, Then no spec/plan is proposed. Given a cross-repo or multi-slice change with an open product choice, Then `shape` proposes a spec and grills the open choices first.
- **Tautology**: Given a test whose expected value is computed by the code under test, Then `workit test-audit` flags it with the reason and a suggested independent oracle.

## Non-goals

- Database as source of truth; a mandatory memory server; phase/milestone ceremony by default.
- Graphite as a dependency; Cursor-cloud-only features.
- Marketplace submission claims.
