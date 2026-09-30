# Workit action reliability

Date: 2026-09-30. Status: Workit 2.0.0 is published; the V2 lifecycle and trigger fixes are implemented and awaiting PR CI.

The v1.3.1 proposal-binding work below is historical for OpenCode mutation
execution. The native-effects cutover at the end supersedes that execution path.

This extends the adaptive spec; it does not authorize live migration or effects
in the user's running sessions. Previously reconciled workspace-resolution changes remain intact.

## Reproduced problem

Saved OpenCode V2 session `ses_f12338d70ffe5maUpR9iR4wujU` requested a local
branch and commit in `web/frontend` from a session in `web/integration`.
The bounded last 130 assistant records contained 33 Workit calls, including
12 invalid-input failures, five needs-input results and one unsatisfied
requirement. A commit proposal before branch creation and another after it
had identical displayed text but different resolved descriptors. The adapter
rejected the approval before checking which descriptor remained current.
Changing the commit message escaped the collision and caused another question.
Task closure then induced an assessment and additional schema retries.

## v1.3.1 required behavior (historical mutation adapter)

1. Resolve all proposals matching an observed approval before deciding whether
   they are ambiguous. Evict only descriptors proven stale by successful fresh
   resolution. Bind exactly one current descriptor; unresolved state or multiple
   current descriptors fails closed. Never choose by age, queue order or newest
   entry. Persistence failure preserves the receipt and current proposal.
2. Advertised inputs come from the canonical schemas. Explain operation-specific
   payload fields, enum values, required fields and nested discriminator shapes
   within the host/provider schema depth bound. Runtime validation remains strict;
   do not accept guessed authority, unknown keys or malformed evidence to reduce
   retries. Errors explain the concrete repair without a new approval ceremony.
3. For routine user-authorized branch/commit work, choose native host tools from
   the outset when no managed uncertainty/coordination is needed. Resolve the
   actual target's rules; keep native permissions authoritative. No Workit task,
   writer or decision record is needed just to call an ordinary native Git tool.
   Do not switch paths to evade a denial or retry an uncertain managed effect.
   Managed actions remain optional for their concrete serialization/reconciliation
   benefits; their tracked state is not a requirement for all Git work.
4. A successful local commit does not imply PR readiness or require a review of
   an endpoint the user did not request. Do not start tracking solely to commit,
   then create closure work. Existing tracked requirements remain enforced; do
   not fabricate assessment/evidence or label unverified work verified.
   For newly assessed bounded behavior changes, retain behavioral verification
   and self-review. Independent review is required for security, data,
   public-contract or operational consequences, the thorough preference, or
   explicit project constraints. Fast mode cannot weaken those requirements.
   Existing stored policies are not silently rewritten or cleared.
5. Preserve coordinator attribution and target checkout serialization. A target
   conflicting writer, changed staged contents, protected ref, wrong identity,
   native denial, ambiguous outcome or unavailable host capability stays blocked.
   Cross-checkout targeting does not require attaching the target to a task.

## Implementation slices and acceptance

- A: stale-proposal binding in the shared OpenCode native runner. Reproduce
  commit proposal, branch change, same-text proposal, one observed approval.
  Also cover uncertain resolution, genuinely ambiguous proposals, persistence
  retry, staged-content drift and session isolation. V1/V2 reuse the same runner.
- B (independent of A): canonical advertised schemas and bounded nested shape
  descriptions. Pin stash yes/no, plan-step variants, reference discriminators
  and blocker fields; retain full runtime parsing and provider depth checks.
- C (independent of A/B): distributed direct/native routing and endpoint guidance,
  with host-parity method tests. No automatic configuration or live-store edits.
- D (after A–C): proactive reliability passes on rejection, concurrency, state
  drift, restart uncertainty, cross-checkout targets, schema/runtime agreement
  and delivery endpoints. Fix reproduced defects in shared code where possible;
  record supported limits and unresolved evidence instead of claiming exhaustiveness.
- Integration: focused regressions, complete check suite and packaged acceptance.
  Builds must not replace the active local-pin artifact while a user session runs;
  use an isolated checkout copy for artifact checks. No live mutation of real
  history or automatic reload of the user's host.

## Reference rationale

[Gentle AI trigger rules](https://github.com/Gentleman-Programming/gentle-ai/blob/72e0cccb1ff10a7cf6ca0270961e903c4d7eb686/docs/trigger-rules.md)
inform direct/delegated/optional-SDD routing and consequential questions.
[OpenCode plugin API](https://opencode.ai/v2/docs/build/plugins/)
defines native capabilities; questions are not permission grants. These references
guide the implementation but do not prove Workit's reliability. Scenario tests
and saved host evidence must do that.

## v1.3.1 proactive audit dispositions

- Approval identity: stale same-text proposals, ask-time ordering, duplicate
  delivery and consumed-receipt replay have regression coverage. V2 must capture
  question provenance in its native before-hook; an answer-time sequence alone
  cannot establish that the question followed the current proposal.
  Call identity and sequence remain for the plugin instance lifetime; evicting
  them after 1,024 calls allowed old delivery to regain eligibility. Pending
  question and available receipt queues remain bounded at 16 entries.
- Concurrency and recovery: retain coordinator writer ownership, target writer
  conflicts, target locks, staged-content drift checks and uncertain-outcome
  reconciliation. Existing tests exercise these boundaries; no reason was found
  to delete them to reduce tool calls.
- Rejection: a rejected proposal must not execute. A later fresh explicit approval
  may authorize the still-current proposal; a retained proposal alone is not an
  authorization. No rejected-action execution defect was reproduced.
- Host authority: native tool permission and plugin-internal subprocess permission
  are distinct. The current custom-tool registration does not demonstrate that
  hidden subprocesses inherit shell permission checks. A question receipt is
  consent evidence, not that missing host guarantee. Task-free managed execution
  is deferred until an adapter can prove native authorization for the actual
  effects; this slice uses ordinary native tools from the outset instead.
  See [V2 tool contract](https://github.com/anomalyco/opencode/blob/dev/specs/v2/tools.md)
  and [native permissions](https://opencode.ai/v2/docs/permissions).
- Cost: richer schema descriptions increase the serialized V2 catalog from
  22,198 to 34,790 bytes in this candidate. This is a JSON size measurement,
  not model tokens or measured latency. Reduced invalid-input retries and
  unnecessary workflow calls are the intended benefit, not a proven benchmark.
- Qualification ceiling: deterministic checks and a private installed-host
  loader probe do not establish one-shot reliability across models. A bounded
  model-driven qualification should measure retries and duplicate questions
  before making that claim. Do not run the budgeted 90-run suite implicitly.

## OpenCode native-effects cutover

User decision, 2026-09-30: remove managed external mutations from both OpenCode
versions rather than retain disabled executors or add a V1-only permission shim.
Native host tools own Git, hosting, YouTrack and documentation effects. Native
denials, sandbox rules and target-repository conventions remain authoritative.

Remove `workit_external_action`, its adapter-only proposal queues, standing
approval orchestration and effect runner. Do not add a compatibility alias that
can still execute mutations. Retain eight shared operation families, native
decision receipts for real policy choices, worker/lifecycle support and config
initialization. Expose the existing read-only contexts through `workit_context`
with a strict flat payload schema; context reads cannot select a mutation.

Shared core/Pi/CLI effect machinery remains in use and is outside this adapter
removal. Persisted action history, pending/unknown outcomes, decisions, tasks and
leases are preserved. Inspection remains available, but an uncertain historical
effect must be reconciled from actual evidence before any native retry. Do not
fake settlement or migrate live history during this cutover.

Acceptance slices:

1. Remove both native registrations and OpenCode-only execution/proposal code;
   verify V1 and V2 expose context, families and init only. No effects alias.
2. Retain strict read-only context validation and session/worker provenance;
   reject mutation-shaped input without Git or Workit state writes. Preserve
   decision receipt replay protection and native shell-policy regression checks.
3. Replace obsolete execution tests and current guidance. Shared effects and
   uncertainty tests for the remaining hosts continue to pass. Qualification
   scripts must not attempt the removed tool or advertise stale capability.
4. Isolated build/full checks, package acceptance and installed V2 private loader
   probe. Preserve the running host's artifact/config until a safe restart.

The installed V2.0.19 bundle uses `options.permission ?? toolName` for coarse
whole-action deny filtering; it does not expose a custom-tool permission assert
for each subprocess. V1 has an async `ToolContext.ask`, but Workit's existing
effects are synchronous and would need another command authorization layer.
Native execution avoids duplicating the host's command scanner and permission
workflow on either version.

## V2 trigger and lifecycle follow-up

This audit follows the Workit 2.0.0 release. It addresses confirmed defects
that could misroute a slash command, strand a durable worker dispatch, or report
contradictory completion, while preserving intentional host behavior.

1. **Skill collision:** V2 skips a Workit skill when the same ID already exists,
   but previously still registered its `/wk-*` alias. The alias then requested
   that exact ID and could load unrelated user instructions. Register each alias
   only when this plugin successfully installed its corresponding Workit skill.
   Acceptance: a pre-existing `workit-debug` skill remains untouched and
   `wk-debug` is absent; other Workit skills and aliases remain available.
2. **Dispatch uncertainty:** V2's after-hook error and a completed result without
   a verified child do not prove that no child was created. Previously both
   released the in-memory correlation while the task worker remained
   `dispatching`; a late `session.created` could no longer bind it. Retain the
   correlation and block another fresh launch until a same-workspace direct
   child is verified or the lead explicitly settles the worker as stopped.
   Keep that correlation through terminal-stop persistence failures so the next
   launch can retry reconciliation. Acceptance: generic error and missing-child
   results keep the slot; a late valid child binds it; a terminal observation
   that initially fails is retried; an explicit lead stop releases it before
   the next assigned worker. A child from another workspace is never bound.
3. **Implement trigger:** the skill body permits ordinary requested
   implementation and makes tracking/delegation optional, but the description
   advertised it only for delegation or shared-checkout work. Update every
   packaged copy to match its actual trigger. Acceptance: the description
   invites the skill for requested implementation and explicitly keeps tracking
   optional; host copies remain byte-identical.
4. **Conflicting child outcomes:** result text can say `state="completed"`
   while OpenCode's session record says `failed` or `interrupted`. The explicit
   host terminal outcome wins; do not create a completed report from conflicting
   result text. Acceptance: failed/interrupted outcomes stop the bound worker
   without a completed report.

Audit dispositions:

- The apparent V2 skill `path`/`location` mismatch is version-sensitive. The
  installed OpenCode 2.0.19 private loader returned Workit skills with `path`;
  keep the pinned runtime field and re-check only with a host upgrade.
- History offers are deliberately a one-time session-start snapshot in both
  V1 and V2. Do not add a per-turn store scan to retry an empty first result.
- Generic operation-family tool descriptions are a discovery concern only; no
  model-driven misrouting has been reproduced. Defer wording changes until a
  bounded model-driven case identifies which description needs correction.
- Deterministic tests and host-loader checks do not establish one-shot model
  reliability. Keep that qualification separate and budgeted; do not claim a
  broad reliability rate from these regression tests.
