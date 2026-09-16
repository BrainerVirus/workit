# Workit Reliability Delta - Implementation Plan

**Spec:** `docs/workit-reliability-delta/spec.md`
**Branch:** `feature/workit-reliability-delta`

Execute every task continuously after this plan is approved. Each task ends in
one atomic commit after its focused RED/GREEN checks pass.

## Sequence

### Task 1: Make action approval usable and outcomes truthful

**Depends on:** approved design decision
`7f7f173f-5240-411c-b2ce-742353cd975f`.

**Files:**

- Modify `packages/workit-core/src/core/external-action.ts` and
  `packages/workit-core/src/core/external-action-effects.ts`.
- Modify `packages/workit-core/src/core/branch.ts`.
- Modify `packages/workit-core/src/core/task-contract.ts` for the shared
  binding-question display budget.
- Modify `packages/workit-opencode/src/plugin.ts` and
  `packages/workit-opencode/src/tools/workit.ts` for the pre-display deny and
  record-time fallback.
- Modify native action adapters in `packages/workit-opencode`,
  `packages/workit-pi`, and `packages/workit-cli`.
- Modify decision contracts/authority only as needed for trusted hidden action
  bindings.
- Test `test/workit-core/external-action.test.ts`,
  `test/workit-core/branch.test.ts`, `test/workit-core/task-contract.test.ts`,
  `test/workit-opencode/task-tools.test.ts`, `test/workit-pi/extension.test.ts`,
  and CLI action tests.

**Work:**

1. Add RED cases for the current no-proposal dead end, raw question content,
   missing writer guidance, action-payload substitution, concurrent identical
   summaries, replay/restart loss, the exact five-minute expiry boundary,
   ambiguous branch summary, remote base advance after approval, and preflight
   errors collapsed to unknown.
2. Return a trusted proposal with concise displayed content plus hidden canonical
   binding; consume it only from the matching native session receipt.
3. Require the setup working branch, report the policy base separately, move all
   validation before manifest-directory/Git mutation, bind the exact remote/base
   commit plus source state, and preserve preflight errors as `not_started`;
   retain unknown only after mutation may have begun.
4. Add near-miss diagnostics and native-host parity checks.
5. Enforce show-before-ask: deny oversize or mis-shaped binding questions at the
   pre-execution question boundary, fail closed at record time otherwise, and
   cover the budget boundary plus ordinary-question pass-through.

**Command:**
`bun test test/workit-core/external-action.test.ts test/workit-core/branch.test.ts test/workit-core/task-contract.test.ts test/workit-opencode/task-tools.test.ts test/workit-opencode/task11-repair.test.ts test/workit-pi/extension.test.ts test/workit-cli/task.test.ts`

**Commit:** `fix(actions): make native approvals concise and actionable`

### Task 2: Remove protocol retry traps

**Depends on:** task 1 for action/decision diagnostics.

**Files:**

- Modify `packages/workit-core/src/core/task-contract.ts`,
  `packages/workit-core/src/core/task-engine.ts`,
  `packages/workit-core/src/core/task-evaluation.ts`, and context/schema adapters.
- Update distributed tool descriptions/bootstrap where revision usage is taught.
- Test core contract/engine/context and host schema projections.

**Work:**

1. Add RED cases for revision-conflict details, omitted close `decisionIds`,
   hashed-only requirement failures, acquire/release reason asymmetry, invalid
   assessment paths, repository-escaping scopes/refs, and missing aging data.
2. Keep strict explicit revisions while making omission the agent-facing default.
3. Derive closure references, report rules/remedies, and give one-repository plus
   external `file://` guidance.
4. Remove placeholder enforcement claims and add deterministic timestamp/blocker
   summaries without another lifecycle.

**Command:**
`bun test test/workit-core/task-contract.test.ts test/workit-core/task-engine.test.ts test/workit-core/task-context.test.ts test/workit-opencode/task-tools.test.ts test/workit-mcp/server.test.ts`

**Commit:** `fix(protocol): make retries and closure actionable`

### Task 3: Correct evidence and state transitions

**Depends on:** task 2 contract changes.

**Files:**

- Modify `packages/workit-core/src/core/task-evaluation.ts`,
  `packages/workit-core/src/core/task-engine.ts`, and task contract fields needed
  for pause state.
- Modify worker adapters only where transition inputs change.
- Test core evidence, worker, writer, pause/resume, revise, and close behavior.

**Work:**

1. Add RED cases for reviewer check+review sessions, candidate pin ordering,
   cancel-held writers, cancelling-to-running, assigned-worker disagreement, and
   pause summary loss.
2. Admit supporting checks from the same independent reviewer while preserving
   creator and duplicate-review exclusion.
3. Auto-bind candidate before pin validation, centralize active/uncertain worker
   classification, and keep late child-start observations in `cancelling`.
4. Make writer release and pause metadata atomic with their transitions.

**Command:**
`bun test test/workit-core/task-evaluation.test.ts test/workit-core/task-engine.test.ts test/workit-core/workers.test.ts test/workit-opencode/task-hooks.test.ts test/workit-pi/worker.test.ts`

**Commit:** `fix(state): align review worker and pause transitions`

### Task 4: Stamp persisted state with the Workit version

**Depends on:** task 2 contract ergonomics; independent of task 3 behavior.

**Files:**

- Modify `packages/workit-core/src/core/task-contract.ts`,
  `packages/workit-core/src/core/task-store.ts`, and package-version resolution.
- Update state export/import/recovery and compact summaries.
- Test new, old, mutated, imported, exported, and recovered records.

**Work:**

1. Add RED cases for missing `createdWith`/`updatedWith`, mutation stamping,
   legacy `createdWith: null`, import preservation, inspect/list visibility, and
   generic pre-delta fail-closed behavior and actionable delta-and-later
   version-skew diagnostics.
2. Resolve the running package version once and stamp it inside existing atomic
   store mutations.
3. Keep metadata outside authority/evidence digests and preserve schema-v1 reads.

**Command:**
`bun test test/workit-core/task-contract.test.ts test/workit-core/task-store.test.ts test/workit-core/state.test.ts test/workit-core/task-engine.test.ts`

**Commit:** `feat(state): record workit runtime versions`

### Task 5: Make host surfaces truthful and shared

**Depends on:** tasks 1-4 contracts stable.

**Files:**

- Modify capability declarations in OpenCode, Cursor, Codex, Pi, MCP, and CLI.
- Modify `packages/workit-cursor/hooks/workit-hook.ts`,
  `packages/workit-mcp/src/server.ts`, and
  `packages/workit-opencode/src/plugin.ts`.
- Consolidate duplicated external-action execution only where all adapters use
  identical core logic.
- Test affected host hooks, MCP schemas, source/bundle paths, and parity.

**Work:**

1. Add RED cases for method capability vocabulary, Cursor stop claims, impossible
   MCP mutations, stale-source paths, and duplicated action outcomes.
2. Advertise only provable assurance, keep uncertain Cursor workers explicit,
   and fix source/bundle marker resolution.
3. Move identical action mechanics into core and leave only native observation in
   adapters.

**Command:**
`bun test test/workit-core/methods.test.ts test/workit-cursor/task-hooks.test.ts test/workit-codex/cli.test.ts test/workit-mcp/server.test.ts test/workit-opencode/bootstrap.test.ts test/workit-pi/extension.test.ts`

**Commit:** `fix(adapters): report only enforceable workflow behavior`

### Task 6: Ship continuous workflow guidance

**Depends on:** tasks 1-5 green.

**Files:**

- Modify `packages/workit-core/src/core/methods.ts` and canonical method skills;
  regenerate/copy host assets through existing scripts.
- Update canonical skills, generated host copies, bootstrap content tests, and
  `AGENTS.md` development guidance.
- Update docs, bootstrap, skill-copy, artifact, and acceptance tests.

**Work:**

1. Pin continuous approved-plan execution, atomic task commits, CI-red
   `workit-green-run`, and pre-merge `workit-blast-radius` guidance.
2. Teach show-then-ask in the bootstrap and `workit-plan`: present durable
   artifacts as a complete digest plus exact path and inline plans as content
   before any approval question; keep questions scoped and never ask unseen.
3. Document one-task-per-repository linked-task handling in installed guidance.
4. Run focused bootstrap and skill-copy tests.

**Command:**
`bun test test/workit-core/methods.test.ts test/workit-opencode/bootstrap.test.ts test/workit-pi/extension.test.ts test/workit-codex/cli.test.ts`

**Commit:** `docs(workflow): continue approved plans without prompts`

### Task 7: Verify, document, and hand off to OpenCode V2

**Depends on:** tasks 1-6 green.

**Files:**

- Review and, if needed, correct any file in the approved task scope.
- Update `docs/opencode-v2/spec.md`, `docs/opencode-v2/plan.md`, `README.md`,
  package READMEs, `AGENTS.md`, and `CHANGELOG.md`.
- Update the traceability table with final test locations and dispositions.

**Work:**

1. Run `workit-deslop` and remove identified code/prose slop.
2. Align V2 contracts and public docs with the implementation.
3. Run focused suites, `bun run check`, deterministic acceptance, and packed
   release-candidate verification.
4. Commit Task 7 only after every repository-changing step above is complete.
5. Obtain fresh-context review against that committed candidate. If review fixes
   change files, land one atomic `fix(runtime): address final review` commit,
   rerun affected checks, and repeat review against the new candidate.

**Commands:**

- `bun run check`
- `bun run test:acceptance`
- `bun run verify:release-candidate`

**Commit:** `docs(runtime): hand off verified reliability contracts`

## Delivery

After the post-commit Task 7 review (and any one corrective commit plus repeated
review), record final behavioral/review evidence, resolve every finding, and only
then create/babysit the PR through the corrected concise action flow.
