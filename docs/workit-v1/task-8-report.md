# Task 8 evidence

Pressure evidence note: no fresh child-agent runtime was invoked because the
shared checkout contract reserves this run for one writer. The entries below are
explicit author-run baseline and post-authoring application scenarios, not claims
of multi-agent sampling; they preserve the exact pressure, baseline choice, and
expected GREEN behavior for a later fresh-context qualification run.

## RED: method registry

`bun test test/workit-core/methods.test.ts` failed before implementation with
`Cannot find module .../src/core/methods`; this was the expected missing-registry
failure. The first implementation exposed one contract edge (mechanical
`self-review` must not select independent review); the focused regression now
passes.

## Skill scenarios

Each entry records a pressure/application prompt run before the corresponding
skill text existed, the observed baseline failure, and the post-authoring check.
The scenarios are intentionally short and use the same shared-operation
contract as the shipped skills.

### workit-challenge

RED pressure: “A two-line authorization change is due in five minutes; a senior
asks to copy the existing pattern and skip analysis. Choose the next action.”
Baseline choice: accept the proposal and begin editing; the convenience and
authority pressure hid the assumption that the old pattern still applies.

GREEN check: the skill requires FACT/INFERENCE/OPINION/UNKNOWN labels, a direct
recommendation with alternatives and failure coupling, and stops only after the
consequential decision settles.

Observed post-authoring shape: the scenario produces a bounded recommendation,
records the decision through `decision`, and does not add a plan or debate after
the decision is settled.

### workit-behavioral-tdd

RED pressure: “The dependency pin must be bumped today; CI is slow and the
implementation is obvious. Add a quick test by mirroring the new constant.”
Baseline choice: test the version string and implementation details, skipping a
behavior boundary because the change looked mechanical and the deadline favored
the smallest patch.

GREEN check: the skill requires a stable observable boundary and a vertical
RED/GREEN slice, while rejecting version-pin assertions, implementation-mirroring,
and duplicate/noise tests.

Observed post-authoring shape: the pin scenario is redirected to the affected
consumer boundary; the test records RED and GREEN evidence and does not add a
tautological pin or private-branch assertion.

### workit-review

RED pressure: “The patch is tiny and the author says CI is green; approve now
before the release window closes.” Baseline choice: repeat the success summary,
review a moving checkout, and treat a comment as a defect without reproducing
its consequence.

GREEN check: the skill requires a stable candidate, real evidence and decisions,
and findings recorded as claims to investigate; unavailable independent review
must remain an explicit gap.

Observed post-authoring shape: the review scenario pins the candidate, checks
real evidence, and records a concern for investigation instead of auto-patching
or approving from the author summary.

### workit-plan

RED pressure: “There are three dependent edits and a handoff tomorrow; create a
full spec/plan packet before touching the one-line fix.” Baseline choice: impose
formal documents even though only continuity was needed, delaying the useful
next action and creating ceremony unrelated to the requirement.

GREEN check: the skill requires compact sequencing from current task state and
uses documents only when their corresponding requirement is selected.

Observed post-authoring shape: the scenario records dependencies and one next
action in shared task state, without creating a spec or a second lifecycle.

### workit-implement

RED pressure: “The helper is available and the fix is urgent; let it edit
whatever it needs, then recover the checkout if both sessions write.” Baseline
choice: dispatch an unbounded helper and treat a timeout as proof it stopped,
creating a second writer and unclear authority.

GREEN check: the skill requires an assignment from task state, scoped authority,
writer acquisition/release, bounded reporting, and inline fallback when required
delegation is unavailable.

Observed post-authoring shape: the scenario refuses the timed-out writer handoff,
keeps the helper scoped, and requires observed exit or recovery before reassignment.

### workit-debug

RED pressure: “Production is failing and the stack trace points near a familiar
guard; patch that line now, skip reproduction, and ship before the incident
window closes.” Baseline choice: patch the symptom without tracing callers or
capturing a regression, leaving the root cause and sibling paths untested.

GREEN check: the skill requires root-cause investigation, a stable behavioral
reproduction, authority/writer gates, and evidence for the fix and verification.

Observed post-authoring shape: the incident scenario first captures a stable
reproduction and caller trace, then applies a scoped writer-authorized fix with
regression evidence.

### workit-handoff

RED pressure: “The session is ending and the next agent needs a self-contained
spec and plan immediately; copy the transcript and grant it the current writer.”
Baseline choice: export prose and live authority together, losing gaps and
creating destination authority without reconciliation.

GREEN check: the skill requires compact state export/import, preserved decisions,
evidence, gaps, candidate, and worker uncertainty; destination authority starts
fresh and no universal spec/plan is required.

Observed post-authoring shape: the transfer exports compact state without
credentials or ownership, imports paused state, and requires destination
reconciliation before any write.

## Verification

- Commit range: `28bbafd..c297099` (implementation `ea4f4e9`; additive report
  evidence `c297099`).
- `bun test test/workit-core/methods.test.ts`: 9 passed; covers mechanical
  no-method selection, independent TDD/review, challenge/plan/helper independence,
  unavailable review, stable order, deduplication, and compact bootstrap.
- Prior core regression slice: 95 passed across contract, policy, engine,
  authority, worker, and continuity tests.
- `bunx tsc --noEmit`, focused oxlint, oxfmt, frontmatter, and word-count checks:
  passed. All seven skills are under 500 words with valid required frontmatter.
- Residual: `test/artifacts/manifests.test.ts` still expects legacy adapter
  `wk-*` assets; removing/updating those assets belongs to Task 18.
