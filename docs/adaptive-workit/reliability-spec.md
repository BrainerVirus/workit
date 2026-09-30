# Workit action reliability

Date: 2026-09-30. Status: implemented and isolated acceptance passed; active-host deployment pending.

This extends the adaptive spec; it does not authorize live migration or effects
in the user's running sessions. Existing workspace-resolution changes are a
separate dirty-tree slice and must remain intact.

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

## Required behavior

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

## Proactive audit dispositions

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
