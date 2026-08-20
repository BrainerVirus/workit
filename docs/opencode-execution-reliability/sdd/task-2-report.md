# Task 2 report — Handoff preflight and automatic selection

## What was implemented
- `assertHandoffReady(root, planPath): FlowGateResult` in `flow-state.ts:1994-2031` — uses effective reconciled state, requires `spec.status === approved`, `plan.status === approved`, `handoff_destination === false`, `menu.presented === true && menu.chosen === "handoff"`. Logical preflight failures return structured error with `code: handoff_not_chosen | recursive_handoff | spec_not_approved | plan_not_approved` and create no session.
- OpenCode adapter `packages/workit-opencode/src/tools/handoff.ts:70-74` now calls `assertHandoffReady` before ANY `session.create` and before `state.set`; removed the prior `assertFlowGates` + ad-hoc `readEffectiveFlowState` + recursive check. Title changed to `Workit: <slug>` (`Workit: x`) instead of `Continue <slug>`. Retains `idempotentMarkDestination` post-seed and TUI `selectSession` with `selected: true` on success, `stage: "select"` with `sessionID` on host selection failure for manual `opencode -s <id>` recovery.
- Both `wk-handoff` skills (`packages/workit-core/skills/wk-handoff/SKILL.md` and `packages/workit-opencode/assets/skills/wk-handoff/SKILL.md`) now document `Workit: <slug>` and that `Continue opencode -s <session-id>` is the native recovery epilogue for `stage: "select"` partial success, not a bug.

## Test results

### Before fix (RED, this session)
- `bun test test/workit-core/handoff.test.ts` — 42 pass / 3 fail:
  - `handoff preflight rejects when menu not recorded before session.create` — Expected `create` 0, got 1 (adapter created before checking menu)
  - `handoff preflight rejects non-handoff menu choice before session.create` — Expected code defined, got undefined (no preflight)
  - `valid non---stay handoff publishes selection and titles Workit: <slug>` — Expected `"Workit: x"`, got `"Continue x"`
- The two other Task 2 tests (`missing flow`, `recursive`) already passed via the old recursive-only check.

### After fix (GREEN)
- `bun test test/workit-core/handoff.test.ts` — 45 pass / 0 fail (3 fixed + 1 title expectation corrected from `Continue x` to `Workit: x`, 42 existing pass preserved).
- `bun test test/workit-core/handoff.test.ts test/workit-opencode/plugin.test.ts` — 69 pass / 0 fail (existing create/seed/mark/select partial-failure coverage unchanged, including `handoff uses live client`, seed-fail, create-fail, select-fail).

## Files changed (5, commit pending base 15de054)
- `packages/workit-core/src/core/flow-state.ts` — added `assertHandoffReady`
- `packages/workit-opencode/src/tools/handoff.ts` — preflight via `assertHandoffReady`, title `Workit:`
- `packages/workit-core/skills/wk-handoff/SKILL.md` — title + recovery guidance
- `packages/workit-opencode/assets/skills/wk-handoff/SKILL.md` — title + recovery guidance
- `test/workit-core/handoff.test.ts` — 5 new tests (missing, unrecorded, non-handoff, recursive, valid title/selection) + 1 expectation fix (`create:Workit: x`)

## Self-review findings
- `handoff-tools.ts` (`handoffSession`) needed no change — it already implements create → seed → mark → select ordering and stage preservation; the title and preflight belong to the adapter and `flow-state.ts` respectively.
- The `undefined code` fail was expected: the old adapter had no `handoff_not_chosen` path, so non-handoff menu slipped to success. `assertHandoffReady` now returns `handoff_not_chosen` for both missing and wrong-choice states.
- Lint `bun run check` still shows pre-existing warnings in `bootstrap.ts` and `flow-fixtures.ts` (unrelated to Task 2); no new warnings introduced by Task 2.

## Concerns / follow-ups
- None for Task 2 scope. Remaining work (Tasks 3-5) will own SDD control gates, delegation identity, and parity/docs.
