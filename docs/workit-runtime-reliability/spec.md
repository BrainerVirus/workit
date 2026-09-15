# Workit Runtime Reliability - Spec

**Branch:** `feature/workit-runtime-reliability`

## Context

Remove the workflow failures observed in recent OpenCode sessions without
weakening provenance or replacing Workit's host-neutral contracts:

- a settled user choice is not asked again only to mint a receipt;
- policy-selected method skills are visible when the agent needs them;
- a managed worker is assigned and durably claimed before its native launch;
- branch and pull-request actions use Workit's policy-aware routes where the
  host can enforce that boundary; and
- failed worker or review provenance has an explicit recovery path and never
  becomes verified by relaxation.

This reliability slice lands before the OpenCode V2 adapter implementation.
The V2 port consumes the corrected behavior rather than extracting the current
defects into a shared adapter layer.

## Goals

- Make decision receipts semantic, deterministic, and non-repetitive.
- Surface policy-selected method skills consistently across hosts.
- Make worker launch ownership durable before native spawn.
- Route branch and pull-request mutations through Workit where enforceable.
- Keep closure truthful and recovery actionable.
- Give optional Effect usage an evidence-based, adapter-local adoption gate.

## Decisions

- Preserve the public `Result<T>` contract and explicit error codes.
- Preserve `TaskStore` as the durable authority for revisions, locks, workers,
  decisions, and evidence.
- Keep host-native observations explicit in each adapter. A shared abstraction
  must not erase whether a host attested an action.
- Do not adopt Effect across `workit-core` or the other adapters.
- Effect may be evaluated later inside the OpenCode V2 adapter only, under the
  adoption gate below. It remains an implementation detail and cannot own
  durable authority.
- Preserve strict `verified` closure. Missing evidence or provenance requires
  recovery or a truthful `stopped` outcome, not an automatic waiver.
- Keep `docs/workit-reliability-overhaul/` historical and unchanged. This spec
  covers only the focused runtime defects listed here.

## Non-goals

- Rewriting the task engine into a general effects system.
- Creating a second task lifecycle, approval protocol, or evidence format.
- Making arbitrary shell parsing a security boundary.
- Claiming enforcement on hosts that cannot observe or block a native action.
- Changing OpenCode V1 and V2 behavior independently.
- Implementing the OpenCode V2 adapter in this slice.

## Architecture

| Boundary | Authority | Effect boundary |
| --- | --- | --- |
| Core operations | Existing schemas, error codes, and `Result<T>` | No Effect values |
| Durable workflow state | `TaskStore` revisions, locks, and atomic mutations | No process-local Effect primitive is authoritative |
| Host adapters | Native receipts, lineage, hooks, and capability reporting | Optional OpenCode V2 orchestration pilot only |
| Agent context | Shared compact task and selected-method projection | No Effect dependency |

## Required Behavior

### 1. Decision receipts

OpenCode keeps native, session-bound, one-use receipts, but recognizes the
contract semantically rather than through incidental presentation text.

- A binding decision still has one question, header
  `Workit decision: <purpose>`, the same label in the question text, and exactly
  two `approved` and `rejected` options.
- Host-added label qualifiers are normalized for comparison while original
  labels remain in the receipt.
- The approved description carries the approved content. The rejected
  description is presentation text and is not required to equal one magic
  string.
- Receipt matching searches the session queue for matching content. A newer
  unrelated receipt with the same purpose does not hide an older valid match.
- A matching stale receipt fails as stale and is consumed. A valid receipt is
  consumed once; replay, wrong session, wrong purpose, wrong answer, and wrong
  content still fail.
- The receipt clock is injectable for deterministic freshness tests.
- When the user already settled the choice and no receipt exists, failure
  guidance says not to ask again. The lead records the settled choice in task
  progress and reassesses so an obsolete decision requirement can retire.

The canonical recognizer is shared by the OpenCode V1 and V2 adapters. Host
event extraction remains adapter-specific.

### 2. Policy-selected methods

`selectMethods(policy, capabilities)` remains the only selector. Its result is
part of the shared compact task projection rather than Pi-only presentation.

- Every applicable agent-loop context contains the current selected method IDs,
  assurance, and compact reasons after policy assessment or reassessment.
- The projection is refreshed on each applicable loop and deduplicated only
  within that hook invocation. A session-level "already injected" flag cannot
  hide a later policy change.
- Pi removes its duplicate rendering once it consumes the shared projection.
- OpenCode V1, OpenCode V2, Pi, Cursor, Codex, and MCP surfaces expose the same
  selected outcome to the extent their host context APIs allow.
- Selection is guidance, not proof that the skill ran. Distributed bootstrap
  text continues to require loading the selected skill before applying it.

### 3. Managed worker dispatch

A native child cannot race ahead of the Workit assignment that authorizes it.

- Add a durable `dispatching` worker state. Under the existing task-store lock,
  preparation changes exactly one worker from `assigned` to `dispatching`.
- The persisted transition is the launch claim. An in-memory map may correlate
  host events, but it is never authority and cannot overwrite another claim.
- For a coordinator with an active Workit task, a fresh managed launch with no
  attributable assignment, assignments spread across tasks, or an unsettled
  claim is denied before spawn with actionable guidance. Native task use outside
  an active Workit task remains unchanged.
- Only the live claim can settle `dispatching` to `running` with a validated
  direct-child session or to `stopped` with host proof that no child started.
- Generic errors, missing metadata, cancellation text, timeouts, and process
  interruption do not prove `not_started`. They leave the claim unresolved.
- Restart reconciliation may settle a claim only from host-observed child or
  terminal data. Inconclusive reconciliation keeps replacement blocked.
- All adapters and the CLI understand `dispatching`. Existing records require
  no migration because their current worker states remain valid. Older runtimes
  encountering the new state must fail closed rather than rewrite it.

### 4. Branch and pull-request routes

Workit's optional-action routes remain the policy-aware path for branch setup,
push, and pull-request creation.

- Where a host exposes a trustworthy shell pre-execution hook, recognizable
  direct `git switch -c` / `git checkout -b`, `gh pr create`, and
  `glab mr create` calls are denied with guidance to use the corresponding
  Workit action. Detection reuses the shared shell-intent boundary and does not
  grow into a general shell parser.
- Pull requests created through `hosting.pull_request` retain drive-mode
  auto-babysit by default.
- If a host cannot block a bypass, its capability remains `agent_guided`. When
  the agent observes a created PR URL, distributed guidance requires loading
  `workit-babysit`; it must not claim the route was enforced.
- Tests cover direct commands, common flags, quoted arguments, compound commands
  that the parser can classify, and unparseable commands that remain explicitly
  non-enforced.

### 5. Closure and recovery

- `verified` continues to require every non-waivable requirement and current
  evidence. A failed or unattributable review never becomes valid evidence.
- A close failure reports the exact blocking requirement or worker and the
  available next action: launch a correctly assigned fresh reviewer, reconcile
  an uncertain worker, or close as `stopped` when verification can no longer be
  established.
- `stopped` may bypass unsatisfied requirements and open findings, as today, but
  it cannot bypass a worker that may still be running. Active-worker recovery
  remains mandatory before every closure outcome.
- No new acceptance path is added for `fresh-context-review` or behavioral
  verification.

## Effect Adoption Gate

Effect is not a prerequisite and is not added by default. The OpenCode V2
Docker spike may recommend an adapter-local pilot only when all of these are
demonstrated:

1. A runnable V2 test exposes lifecycle complexity in subscription cleanup,
   cancellation, bounded retries, or concurrent event correlation that remains
   error-prone after the durable dispatch fix.
2. Effect removes duplicated mutable orchestration rather than wrapping a short
   `AbortSignal`, promise, or task-store operation.
3. Effect values terminate inside `packages/workit-opencode`; shared core and
   public tools still accept and return the existing contracts and `Result<T>`.
4. `TaskStore` remains the only durable authority. `Ref`, queues, semaphores,
   scopes, and fibers are local coordination aids only.
5. Interruption or finalization never becomes proof that a worker did not start
   or that a remote mutation did not occur.
6. The packed plugin stays self-contained, passes V1/V2 parity, and does not
   require consumers to install Effect separately.

If the spike does not meet every condition, use the platform's `AbortSignal`,
promises, and the existing store transaction instead. Adoption requires a
separate recorded design decision after spike evidence; this spec does not
pre-approve the dependency.

## Acceptance criteria

- CA-01: A receipt-shaped question with non-magic rejected presentation text records
   one valid decision; unrelated newer receipts do not shadow a valid match.
- CA-02: An already stated choice with no receipt produces no re-ask instruction and
   can retire through progress plus reassessment.
- CA-03: A policy that selects `workit-challenge` appears in shared task context on
   the next loop across host context tests.
- CA-04: Two concurrent launches from one coordinator cannot claim or overwrite the
   same worker, including across separate core instances using one task store.
- CA-05: A managed launch before assignment is denied before a child starts; a native
   task outside active Workit coordination is unaffected.
- CA-06: Started, not-started, interrupted, restarted, and inconclusive worker paths
   preserve truthful durable states.
- CA-07: Recognized raw branch and PR creation routes are redirected where the host can
   enforce them; weaker hosts report `agent_guided` and still trigger babysit
   guidance from an observed PR URL.
- CA-08: Missing review provenance denies `verified` but allows `stopped` after no
   active or uncertain worker remains.
- CA-09: Existing host parity, package, typecheck, lint, format, and repository tests
   pass without Effect in core.
