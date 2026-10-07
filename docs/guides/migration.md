# Migration: 2.x to 6.x

Upgrade every host together. A runtime that reads a store record written by a
newer major stops with "upgrade Workit" instead of guessing. Preview first with
`workit upgrade`, then `workit upgrade --apply --confirm`.

## 3.0: OpenCode V1 removed, admin code moved to the CLI

- The plugin exports only the V2 `setup()` entry and needs OpenCode 2.0.18+.
  OpenCode 1.x hosts pin `{ "plugin": ["@brainervirus/workit-opencode@2"] }`.
  After upgrading OpenCode, use `"plugins": ["@brainervirus/workit-opencode"]`.
- `workit cutover` and its doctor checks are removed.
- Setup, doctor, upgrade, host-install and uninstall code moved from
  `@brainervirus/workit-core` into the CLI; deep imports of those paths break.

## 4.0: event store and implicit tasks

- Task state moves to an append-only event store under `.git/workit/`, shared
  by all worktrees. A 2.x/3.x `.workit/` store migrates automatically on the
  first CLI command in that checkout (backup kept).
- One implicit task per branch: `workit task status|start|note|close|adopt`
  need no ids. Migrated tasks are unbound; bind one with `workit task adopt <id>`.
- `state.recover` and the recovery directory are removed. `workit gc --json`
  reports `compacted`, `blobs`, `legacyRecovery`, `retried`, `failed`.

## 5.0: skill set v3

Sixteen skills became eleven; the old `wk-*` aliases are gone.

| Old skill (alias) | Now |
| --- | --- |
| `workit-challenge`, `workit-plan`, `workit-diagram`, `workit-mockup` | `workit-shape` (`/wk-shape`) |
| `workit-behavioral-tdd` (`/wk-tdd`) | `workit-bdd` (`/wk-bdd`) |
| `workit-blast-radius` | `workit-review` (`/wk-review`) |
| `workit-babysit`, `workit-green-run` | `workit-ship` (`/wk-ship`) |
| `workit-steer`, `workit-handoff` | `workit-continue` (`/wk-continue`) |
| (new) | `workit-fanout` (`/wk-fanout`), `workit-verify-app` (`/wk-verify-app`) |

`workit ledger verdict --as <role>` only keeps verifier ids distinct; it never
makes the author independent. Each verifier runs under its own session id.

## 6.0: autonomy grants replace approvals

- Removed: the approval-ticket chain (host question answers, Pi
  confirmations, CLI TTY confirmations), standing `autoApprove`, managed
  external actions (`workit action`, Pi's `workit_external_action`) and the
  writer/checkout lease.
- Authority is now your host's permission system plus per-workspace
  [autonomy grants](grants.md). A legacy `autoApprove` is read once as grants
  and folded into `autonomy` on the next `workit grant` write.
- Without a named endpoint, agents stop at a local commit unless
  `defaultEndpoint` is `pr`.

## Ledger hash chain (after 8.0)

- Rows the CLI writes now carry a `prevHash`/`rowHash` chain. Rows written
  before the upgrade read as legacy. A row appended later by an older Workit
  install (another host, a stale CLI) has no chain fields, so `ledger check`
  and `workit ledger verify-integrity` report it as `unsigned`. That is a
  warning only; upgrade every host to stop it.
- `--supersedes` now links only rows of the same branch and verdict kind, so
  old cross-branch or cross-kind links are ignored and the rows they hid
  count again. Record a fresh verdict if `ledger check` changes.
