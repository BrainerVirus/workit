# Plan: wk-* aliases, commit flavors, atomic linkage, session ownership

**Spec:** docs/wk-aliases-commit-ownership/spec.md · **Branch:** `feature/workit-v1`

## Sequence

1. **Aliases.** Replace `WORKIT_SKILL_ALIASES` values with `wk-` keys for all 14 skills (`skill-manifests.ts`).
   Files: Create/Modify `packages/workit-core/src/core/skill-manifests.ts`, opencode `plugin.ts` command entries, Cursor `commands/wk-*.md` + manifest, Pi `registerCommand` loop, codex README note.
   Interfaces: alias table consumed read-only by adapters; no core signature changes.
   Steps: RED — plugin/extension tests assert 14 `wk-` entries, zero bare; GREEN — implement; commit.
2. **Flavors.** Add `commitPolicy` (preset + custom) to config; enforce at `git.commit` resolve; repo detection helper (`detectCommitFlavor`, pure, tested on fixtures).
   Files: Modify `packages/workit-core/src/core/config.ts`, `external-action.ts`, `external-action-effects.ts`; Test `test/workit-core/commit-flavor.test.ts`.
   Steps: RED — reject test for bad message, accept tests per flavor, detection fixture tests; GREEN; commit.
3. **Linkage.** Append `Task: <id>` trailer in `git.commit` settle; one-slice-one-commit rule into `workit-plan`/`workit-implement` skills.
   Files: Modify `external-action-effects.ts`, 5 skill-copy sets; Test settle trailer assertion.
   Steps: RED — trailer present test; GREEN; commit.
4. **Ownership.** Owner session on task list output; owner-check on close/revise/evidence (fail closed, handoff escape).
   Files: Modify `task-engine.ts`, `task-store.ts` list shape; Test foreign-mutation denials + handoff transfer.
   Steps: RED — denial tests; GREEN; commit.
5. Full suite + lint/format/tsc; fresh-context reviewer; resolve; close.

## Dependencies

- (2)-(4) need (1) only for alias-table shape stability; otherwise independent.
- (5) needs (1)-(4) green.
- No pushes without approval; branch `feature/workit-v1` stays local.

## Acceptance

- CA-01..CA-07 each traced above; suite green; review approved.

## Next action

Implement slice 1 on user go-ahead.
