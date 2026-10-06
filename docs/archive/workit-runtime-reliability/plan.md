# Workit Runtime Reliability - Implementation Plan

**Spec:** `docs/workit-runtime-reliability/spec.md`
**Branch:** `feature/workit-runtime-reliability`

## Sequence

### Task 1: Make decisions and methods deterministic

**Depends on:** approved architecture decision
`cc4668cf-39c3-4f1b-8d13-662e962f2afe`.

**Files:**

- Modify `packages/workit-opencode/src/tools/workit.ts`.
- Modify `packages/workit-core/src/core/methods.ts` and
  `packages/workit-core/src/core/task-context.ts`.
- Modify host context adapters only where they duplicate or omit the shared
  projection.
- Test `test/workit-opencode/task-tools.test.ts`,
  `test/workit-opencode/task11-repair.test.ts`, and
  `test/workit-core/methods.test.ts` plus affected host context tests.

**Work:**

1. Add failing cases for non-magic rejected descriptions, host-qualified labels,
   an unrelated newer same-purpose receipt, injected freshness time, and the
   no-re-ask failure message.
2. Implement one V1/V2-ready receipt normalizer and matching queue behavior.
3. Add failing shared-context cases for a newly assessed decision/challenge
   policy, then project `selectMethods()` through `compactTaskContext()` and
   remove Pi's duplicate method text.
4. Run
   `bun test test/workit-opencode/task-tools.test.ts test/workit-opencode/task11-repair.test.ts test/workit-core/methods.test.ts test/workit-pi/extension.test.ts`.

**Evidence:** RED demonstrates each current omission; GREEN proves exact receipt
security remains and selected methods refresh after assessment.

**Commit:** `fix(runtime): align receipts and method context`

### Task 2: Make worker launch claims durable

**Depends on:** task 1 only for clean review sequencing.

**Files:**

- Modify `packages/workit-core/src/core/task-contract.ts`,
  `packages/workit-core/src/core/task-engine.ts`, and worker evaluation/recovery
  code as required.
- Modify `packages/workit-opencode/src/plugin.ts` and
  `packages/workit-pi/src/worker.ts`.
- Update all other adapters and CLI serializers that exhaustively handle worker
  states.
- Test `test/workit-core/task-contract.test.ts`,
  `test/workit-core/task-engine.test.ts`,
  `test/workit-opencode/task-hooks.test.ts`, and
  `test/workit-pi/worker.test.ts`.

**Work:**

1. Add failing tests for two simultaneous preparations through separate core
   instances, launch-before-assignment, restart with an unsettled claim, and
   inconclusive reconciliation.
2. Add the `dispatching` state and atomically claim `assigned → dispatching`
   under the existing store mutation.
3. Require the live claim for `running` or host-proven `not_started` settlement;
   preserve uncertainty on generic failures.
4. Add closure-message tests proving missing review denies `verified`, permits
   `stopped` after worker settlement, and blocks all outcomes while a worker may
   still be live.
5. Run
   `bun test test/workit-core/task-contract.test.ts test/workit-core/task-engine.test.ts test/workit-opencode/task-hooks.test.ts test/workit-pi/worker.test.ts`.

**Evidence:** one persisted claim wins every race; no adapter can infer a safe
terminal state from absence of evidence.

**Commit:** `fix(workers): persist dispatch claims`

### Task 3: Route branch and pull-request mutations

**Depends on:** task 1 for distributed no-re-ask and method guidance; independent
of task 2 behavior.

**Files:**

- Modify `packages/workit-core/src/core/shell-intent.ts` only if the existing
  classifier cannot expose the narrow route classes.
- Modify host hooks that can deny recognizable shell calls.
- Modify `packages/workit-core/src/core/methods.ts` or the canonical babysit skill
  only for the observed-PR fallback.
- Test shell-intent, OpenCode/Codex/Pi hook, and
  `test/workit-core/external-action.test.ts` behavior.

**Work:**

1. Add failing cases for recognizable direct branch creation and hosting-create
   commands, plus unparseable commands that must remain explicitly unenforced.
2. Deny only the narrow recognized forms and return the exact Workit route to
   use. Preserve host-native permission behavior for everything else.
3. Prove `hosting.pull_request` still emits drive-mode babysit by default and an
   observed bypass URL still tells the agent to load `workit-babysit`.
4. Run focused host tests and `bun test test/workit-core/external-action.test.ts`.

**Evidence:** policy-aware routes are enforced where observable without claiming
that shell parsing is universal.

**Commit:** `fix(actions): route branch and PR creation`

### Task 4: Gate and hand off to OpenCode V2

**Depends on:** tasks 1-3 green.

**Files:**

- Update `docs/opencode-v2/spec.md` and `docs/opencode-v2/plan.md` only if
  implementation evidence changes their contract.
- Update `README.md`, `AGENTS.md`, and `CHANGELOG.md` with the product change.
- Add or update packed parity tests for every affected host.

**Work:**

1. Run focused suites, then `bun run check`.
2. Run `bun run test:acceptance` and `bun run verify:release-candidate` when the
   reliability candidate is ready for release verification.
3. Record a fresh-context review of the complete candidate.
4. Close the reliability task before extracting the V1/V2 shared adapter.
5. Run the V2 Docker spike. Evaluate Effect only against the six adoption
   conditions in the spec and record a separate decision if every condition is
   met.

**Evidence:** full parity is green; the V2 task starts from corrected contracts;
Effect is either rejected with no dependency added or approved for one bounded
adapter-local pilot.

**Commit:** `docs(opencode): hand off corrected runtime contracts`

## Next Action

All four tasks are landed and closed (`ecccfc0`, `1bd7374`, `a70a8a5`,
`8338cbf`). The OpenCode V2 dual entry starts with the disposable Docker
contract spike in `docs/opencode-v2/plan.md` step 3; the Effect pilot decision
follows that spike against the adoption gate above and is not pre-approved.
