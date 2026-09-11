# Spec: wk-* aliases, commit flavors, atomic linkage, session ownership

**Branch:** `feature/workit-v1`

**Change:** ADDED — every skill slash-reachable under one prefix; commits gain flavor enforcement and task linkage; sessions gain ownership. (Settled in workit-challenge discussion; question receipts not in `Workit decision:` format, so decisions live here and in task progress.)

## Context

Five bare aliases cover five skills; nine skills need the skills picker. `git.commit` accepts any message while releases depend on Conventional Commits. Commits carry no task link. Any session can mutate any task.

## Goals

- All 14 skills invocable as `/wk-<name>` on opencode, Cursor, Pi.
- `git.commit` rejects messages outside the configured flavor (fail-closed).
- Each commit carries its task id; one slice, one commit is the enforced rule.
- Foreign-task mutations fail closed except via handoff; ownership is visible.

## Non-goals

- Codex slash (does not exist; `$workit-*` documented only).
- Changing squash-merge settings or semantic-release itself.
- Strict isolation (reads stay shared by design).

## Architecture

N/A (reason) — four small core deltas plus adapter alias tables, no new flows. Per-slice mechanics live in the plan.

## Data flow / contracts

| Contract | Shape |
| --- | --- |
| Alias | `wk-<short>` → `workit-<skill>`; alias never calls another alias |
| Commit flavor | `commitPolicy` preset (`conventional`/`gitmoji`/`ticket-prefix`/`freeform`) + `custom`; detection samples `git log --format=%s -30`, majority ≥70% wins, else configured preset |
| Task link | `Task: <id>` trailer on every workit-created commit |
| Ownership | task lists show owner session; close/revise/evidence on foreign tasks fail closed; handoff transfers |

## Acceptance criteria

- CA-01 `/wk-<name>` resolves for all 14 skills on opencode, Cursor, Pi; bare 5 removed (no 19-entry duplication).
- CA-02 Codex documents `$workit-*` only; no `prompts/` shims.
- CA-03 Non-matching commit messages rejected at `git.commit` resolve with the expected flavor named; `custom` escape hatch works.
- CA-04 Repo detection picks the majority flavor on a mixed-history fixture; below threshold it falls back without error.
- CA-05 Every workit-created commit carries `Task: <id>`; squash path unaffected.
- CA-06 Foreign `close`/`revise`/`evidence` fails closed; owner-labeled list; handoff transfers ownership.
- CA-07 Full suite green; fresh-context review approved.
- CA-08 Writes under configured `trustedPaths` pass the gate with writer held; unlisted outside paths still denied; adapters pass absolute trusted paths through instead of pre-denying.

## Decisions

- D-01 wk- for all 14, replace bare 5 (collision-free namespace beats brevity).
- D-02 All four slices, sequenced aliases → flavors → linkage → isolation.
- D-03 Middle-path isolation (labels + destructive-op denial + handoff).
- D-04 Thin linkage (trailer + skill rule) because squash erases branch history anyway.
- D-05 Trusted-paths escape hatch (slice 5, user-reported block): user-config
  `trustedPaths` allowlist; paths under it bypass inside-checkout and scope
  denials but still require writer ownership; default empty preserves
  fail-closed for everyone else.

## Review checklist

- [ ] Intent matches; nothing extra (no strict isolation, no release changes).
- [ ] Each CA testable with an exercising scenario.
- [ ] Tasks trace to CAs (see plan).
- [ ] Would sign if built exactly as written.

## Future work

- Strict isolation mode; custom commit types UI; per-repo flavor pinning.
