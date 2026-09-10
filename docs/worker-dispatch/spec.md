# Spec: worker dispatch mechanics (fan-out binding + scoped launch veto)

**Task:** `0a69b21e` · **Finding:** `a87c0bf5` · **Status:** spec + plan only, no runtime changes.

## Problem (observed, twice)

1. Five parallel assigned reviewers stayed `session: null` forever: none
   could record evidence or report, and the lead may not report for them
   (`workers can submit only their own report`). Lead-reconciled evidence
   cannot satisfy review rules either (see §4). Fan-out review is unusable;
   only exactly-one-assigned serial review binds.
2. One `cancelling` worker vetoed **all** native `task` launches, including
   unrelated ones, until re-cancelled. A stuck worker is a global stop-the-
   world switch.

## Mechanism (traced to code)

1. **Binding is exactly-one-or-nothing.** `tool.execute.before` for the
   native `task` tool calls `prepareDispatch(coordinator, callID)`
   (`packages/workit-opencode/src/plugin.ts:342-390`, wired at `:725`).
   Eligible = `assigned` + `session: null` + provenance session handle ==
   coordinator. `if (eligible.length !== 1) return` — ambiguity is left
   unrecoverable on purpose, so five eligible reviewers bind nothing, ever.
   The reservation then lives for exactly one task call (`:672`); the
   observed child binds via `commitDispatchStart` → `lifecycleBindings`.
2. **Launch veto is global.** The same `before` hook throws when **any**
   worker in **any** task is `cancelling`/`unknown`
   (`packages/workit-opencode/src/plugin.ts:707-717`), plus the
   `unresolvedTaskLaunches` set. Recovery is re-cancel on the ended worker
   (verified working: `cancelling` → `stopped`).
3. **Unbound children cannot use workit tools.** Child sessions without a
   validated worker get `permission_denied` on evidence/report writes.
   Sound — it stops forged voices.
4. **Review satisfaction needs foreign sessions**
   (`packages/workit-core/src/core/task-evaluation.ts:460-473`): kind must
   be `review`, `reviewContext` must equal the recorder's own session, and
   that session must differ from both the task intent session and every
   other evidence session. Sound — it enforces fresh, uncounted eyes. The
   lead can never self-satisfy a review rule on its own task.

## Decisions requested at implementation time

- (D1) Queued fan-out binding (option A below) vs serial-only status quo.
- (D2) Same-task veto scoping (option B) vs global veto status quo.

## Options

### A. Queued fan-out binding (recommended)

Keep one-binding-per-observed-child, but replace `eligible.length !== 1 →
return` with a per-coordinator queue: each serial native `task` call binds
the oldest still-unbound eligible worker. Parallel-assigned reviewers launch
serially (one `Task` call each) and each binds in turn. No identity is ever
guessed: a call with zero eligible workers prepares nothing, and a call
that produces no observed child settles `not_started` as today.

- Touches: `plugin.ts` `prepareDispatch` (+ `dispatches` map lifecycle).
- Tests: two assigned reviewers bind across two serial launches with
  distinct child sessions; three-assigned + one-launch leaves two
  unbound; ambiguous same-call races still bind nothing.
- Risk: low — additive branch; the exactly-one fast path is unchanged.

### B. Same-task launch veto (recommended)

Narrow the `before`-hook veto (and `unresolvedTaskLaunches`) to workers on
the same task the launch targets — or, when the target is unknowable
pre-dispatch, to workers attributable to the launching coordinator.
Unrelated tasks never block each other; the anti-forgery guarantee holds
exactly where a forged stop would matter.

- Touches: `plugin.ts` `tool.execute.before` veto predicate.
- Tests: cancelling worker on task X blocks launches touching X, allows
  launches on task Y; re-cancel recovery unchanged.
- Risk: medium — the veto is a security control; the review must prove no
  cross-task forgery path opens.

### C. Keep the review rule and tool denial as-is (recommended)

Both are sound anti-forgery controls. Document them instead (AGENTS.md
worker-launch paragraph + the ask-once receipt rule pattern):
review evidence needs a foreign session, and only bound workers speak.

### D. Document the double-cancel recovery (recommended, immediate)

One AGENTS.md/CLI-help line: re-cancel an ended worker to confirm its stop
before launching again. Zero code.

## Out of scope

- Decision-receipt linkage (finding `b611654d`, separate tooling gap).
- Pi/Cursor dispatch (stock-Pi and policy-only paths have their own
  lifecycle contracts; revisit only with host evidence).
