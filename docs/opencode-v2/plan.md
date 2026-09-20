# Workit OpenCode V2 - Plan

## Sequence

### 1. Finalize the contract (this task)

- Update `spec.md` and this plan from the OpenCode `2.0.3` docs, package types,
  source, and pinned V1/V2 images.
- Keep this slice documentation-only. Do not install V2 on the live host or
  change product packages.
- Reconcile every recorded review finding, run docs checks, and close.

### 2. Landed: runtime-reliability prerequisite

`docs/workit-runtime-reliability/plan.md` is complete on
`feature/workit-runtime-reliability`; each task closed verified with RED/GREEN
evidence and an independent fresh-context review:

- `ecccfc0` semantic decision receipts (normalized labels, matching-queue
  search, injected clock, no-re-ask guidance) and per-loop selected-method
  projection.
- `1bd7374` durable `dispatching` claims with host-proof settlement,
  unbound/unsettled launch denial, and closure/resume blocking.
- `a70a8a5` narrow shell route enforcement on OpenCode, Codex, and Pi plus the
  observed-route babysit fallback in all five skill copies.
- `8338cbf` README/AGENTS/CHANGELOG handoff and host skill parity coverage.

Gates: `bun run check` 1352/0, deterministic acceptance 24/0, release-candidate
verification of all 7 tarballs. No Effect dependency was added.

Exit condition satisfied: OpenCode V1 exposes the corrected contracts that V2
ports; do not re-implement them in the V2 adapter.

### 2b. Landed: reliability delta

`docs/workit-reliability-delta/plan.md` landed on
`feature/workit-reliability-delta` after the prerequisite:

- concise action approvals with proposal-before-reservation, hidden exact
  descriptors, a display budget for binding questions, and record-time
  fallbacks (`fix(actions)`);
- plan-scoped commit approvals so one approved list covers the plan's atomic
  commits (`feat(actions)`);
- protocol ergonomics, evidence/state correctness, and runtime metadata
  (`fix(protocol)`, `fix(state)`, `feat(state)`);
- host truthfulness (fresh-context-review capabilities, real stale-source
  paths) and guidance for show-before-ask plus continuous approved-plan
  execution (`fix(adapters)`, `docs(workflow)`).

V2 consumes these shared contracts; it must not re-implement or bypass them.

### 3. Run a disposable Docker contract spike

Open a follow-up task scoped to a disposable probe plus a tracked, reusable
Docker harness under `test/`; do not change the Workit adapter implementation.

- Start the exact V2 image/digest from `spec.md` with a temporary HOME/XDG
  config and no host credentials.
- Run a deterministic OpenAI-compatible stub on an isolated Docker network.
- Load a minimal V2 probe plugin and use the HTTP API driver to confirm:
  - plugin/package loading and cleanup;
  - `subagent` tool name, `event.id`, structured success/error results, and
    concurrent tool execution;
  - created/execution/deleted event envelopes and ordering;
  - shell permission action/resource values and the shell deny path, including
    recognized branch/PR route denial with guidance and unparseable-command
    pass-through;
  - question completion metadata plus form API replies;
  - context and compaction hook behavior; and
  - unchanged V1 config normalization versus native V2 config.
- Keep the mock provider, API driver, config fixtures, and container command as
  runnable test assets; remove only the disposable probe after its observations
  are captured. Revise `spec.md` only if the pinned runtime contradicts the
  pinned source.

Exit condition: the harness can deterministically drive every host surface
needed by the later parity matrix without model credentials or live remotes.

### 4. Decide whether an adapter-local Effect pilot is justified

Use the Docker harness to exercise concurrent subagent events, missed terminal
events, cancellation, subscription cleanup, and bounded reconciliation after
the durable dispatch fix.

- Default to native `AbortSignal`, promises, and the existing task-store
  transaction.
- Consider Effect only if a runnable failing case demonstrates remaining
  lifecycle complexity and an adapter-local implementation is materially
  smaller or safer.
- Keep all Effect values inside `packages/workit-opencode`; preserve public
  `Result<T>`, explicit host observations, and `TaskStore` authority.
- Never treat interruption or scope finalization as proof of `not_started`,
  `stopped`, or a remote action outcome.
- If every adoption condition in `spec.md` section 6 passes, record a separate
  design decision for one bounded V2 adapter pilot. Otherwise record the native
  implementation choice and add no dependency.

Exit condition: the V2 implementation has one evidenced orchestration approach;
the dependency choice is not left implicit.

Outcome (recorded 2026-09-18): native implementation choice, no Effect
dependency. `test/opencode-v2/lifecycle.test.ts` (4/4 green, opt-in
`WORKIT_V2_HARNESS=1`) proves every lifecycle scenario with native
primitives — concurrent launches complete with unique event ids, interrupt
yields honest `interrupted`/`aborted` envelopes, missed terminal events
reconcile via polling, unload fires cleanup and reload re-runs setup, and
`session.get` settles within a 5-poll budget. No runnable failing case
exists, so spec section 6 condition 1 fails and the gate stays closed.
Counter-case for reopening: a future runnable failure (e.g. missed-event
storms or cancellation races under real load) that native polling cannot
cover. The harness also fixed one real finding en route: the probe was
installed twice (config + location), duplicating every event id; it now
installs location-only.

### 5. Implement the dual entry

Open a behavior-change task and use the Docker spike evidence as authority.

Package and build:

- Add `src/index.ts`, `src/v1/server.ts`, `src/v2/plugin.ts`, and the minimum
  `src/shared/` modules needed by both adapters.
- Keep `src/plugin.ts` as a thin default re-export and keep published
  `dist/plugin.js`.
- Build `src/index.ts` to `dist/plugin.js` and pin/bundle
  `@opencode/plugin@2.0.3`.
- Update asset resolution for source and bundled layouts.
- Update only tests/tooling that must understand the dual object; setup,
  doctor, sync, cutover, root exports, and checkout pins should remain on their
  existing stable paths.
- Raise the declared and enforced V1 floor to `1.18.30`: support matrix,
  doctor, CI `OPENCODE_MINIMUM`, and manifests tests. Object entrypoints exist
  only from `1.18.29`, so older hosts must fail support checks instead of
  loading the wrong export shape.

Adapter behavior:

- Extract host-neutral execution and receipt logic without sharing mutable V1
  hook closures or SDK context types.
- Register the exact 10 tool names, 14 active skills, and 14 collision-safe
  commands.
- Adapt V2 root/session/result/schema shapes explicitly.
- Implement V2 question receipts from the completed tool result.
- Reuse the corrected semantic receipt recognizer and shared selected-method
  task projection from the reliability prerequisite.
- Implement the V2 execution lifecycle event adapter and sparse deletion rule.
- Deny a second in-flight fresh subagent launch per coordinator; treat existing
  session continuation separately and conservatively preserve no-child
  uncertainty. Claim the single fresh-launch slot synchronously before awaited
  validation and release it on settlement or pre-reservation failure, while core
  `prepareWorkerDispatch` persists the durable `dispatching` claim before the
  spawn attempt. Deny a managed launch before spawn when no attributable
  assigned worker exists or a claim is unsettled; settle the durable claim only
  from host evidence.
- Reconcile unresolved workers through bounded session reads before a veto
  blocks launches, so a missed terminal event cannot deadlock the coordinator.
  A durable `dispatching` claim stays unresolved through inconclusive
  reconciliation and keeps replacement, closure, and resume blocked.
- Inject bootstrap/task/worker context through `context`, compaction context
  through `compaction`, and both worktree and recognized branch/PR route denial
  through shell permission evaluation using `shellRouteIntent`.

Exit condition: focused V1 and V2 adapter tests pass and the packed artifact
contains one dual entry plus all method skills.

### 5b. Execution sequence (one atomic commit per task)

Validated V2 mechanisms (spike evidence): plugin tools reach model requests
only with `options: { codemode: false }`; `execute.after` carries
`input`/`result.output.{sessionID,status,output}`/`result.metadata`
(receipts) and full child lineage (fresh vs continuation by input
`sessionID`, invalid ids error as `tool.execution`); permission `evaluate`
carries `{sessionID, agent, action, resources[], source}` with mutable
`effect`/`message`; prompt-hook edits persist, context-hook system edits do
not reach the provider; compaction validates the fixed section template.

1. `feat(opencode-v2): dual-entry package layout with V1 re-export`
   (`src/index.ts`, `src/v1/server.ts` move, `src/plugin.ts` re-export,
   build from index, V1 behavior unchanged + tests proving it)
2. `feat(opencode-v2): V2 plugin shell with tool registration`
   (`src/v2/plugin.ts` setup, shared tool definitions, 10 tools with
   `codemode: false`, plugin id `workit` in `ctx.plugin.list()`)
3. `feat(opencode-v2): subagent lifecycle with lineage and reservations`
   (fresh/continuation/nested handling, single fresh-launch slot, core
   dispatch claims, bounded reconciliation reads)
4. `feat(opencode-v2): question receipts, permission deny, session hooks`
   (execute.after receipts, shell/worktree route denial, prompt/context/
   compaction hooks)
5. `feat(opencode-v2): skills, commands, config lanes, V1 floor`
   (14 skills, 14 commands, V1-shaped + native config lanes, 1.18.30
   enforcement, asset resolution, packaging)
6. `test(opencode-v2): dual-artifact matrix lanes` (harness lanes for every
   section-10 check against the packed artifact)
7. Verification evidence only; then docs, deslop, review, PR, babysit, close.

### 6. Run dual-host acceptance

Build and `npm pack` the candidate once, then test that same artifact:

- V1 `1.18.30` image: real host load through `server()`, exact V1 surface and
  behavior, stable source/dist paths, and a byte-unchanged host config after
  the lane.
- V2 `2.0.3` image, V1-shaped config copy: normalization and full parity.
- V2 `2.0.3` image, native config copy: full parity.
- Run all 16 checks in `spec.md` section 10, including parallel launch,
  unbound-launch denial, continuation, background lifecycle, an injected missed
  terminal event, route denial with unparseable pass-through, command collision,
  active skill content, persisted-prompt non-mutation, unload/reload, and
  packed-artifact checks.
- Confirm doctor, CI, and manifests tests enforce the `1.18.30` V1 floor.
- Run `bun run check` after the container matrix.

Do not execute remote Git, hosting, or YouTrack mutations. The external-action
lane uses `context.read` and approval-gate assertions only.

Exit condition: all three host/config lanes and repository checks pass against
the same candidate artifact.

### 7. Document and release

- Update README and package README install/support notes.
- Update `AGENTS.md` host parity notes and `CHANGELOG.md` Unreleased in the same
  product change.
- Preserve Cursor, Pi, Codex, MCP, and CLI outcomes; run the normal full parity
  and release-candidate checks.
- Open the PR and babysit it to merge-ready.
- Keep the live host on V1 until the merged/published package passes the same
  V2 packed-artifact smoke. Host replacement is a separate, explicit action.

## Next action

The runtime-reliability prerequisite is landed and closed. Run the disposable
Docker contract spike (step 3) against the pinned V2 image, then record the
Effect decision (step 4) against `spec.md` section 6. Do not start the
dual-entry product port or add Effect until both gates are complete.
