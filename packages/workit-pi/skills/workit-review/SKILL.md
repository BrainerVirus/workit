---
name: workit-review
description: Use when policy requires fresh-context review of a candidate or when an independent correctness and regression check is requested
---

# Review a candidate

Review the real candidate in a stable context. A review is evidence about the
current candidate, not an author's success summary.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Pin or identify the candidate revision before reading conclusions. Inspect the
   task objective, scope, constraints, accepted decisions, changed files, and
   actual checks through shared `task`, `evidence`, and `policy` operations.
2. Examine intent, correctness, regression risk, security or data consequences,
   and project standards. Use the actual diff and check output; do not infer
   evidence from a claim.
3. Record each concern as a `finding` claim with its affected scope and candidate.
   Investigate it: reproduce or trace the consequence, then fix in scope, dismiss
   with evidence, defer with a reason, or ask the user about a real tradeoff.
4. Reconcile conclusions when the candidate changes. Run one substantive review
   and targeted rechecks; do not cycle reviewers indefinitely.

If the required independent context is unavailable, record the review method as
`unavailable` and preserve the gap. Same-session self-review is not independent
review and must not be relabeled as verified.

Use shared `evidence` and `finding` operations. Do not create a parallel review
lifecycle, universal review panel, or direct metadata files.

## Two axes, pinned

Pin the fixed point first (`git diff <base>...HEAD` plus log); review that
candidate only. Judge on two axes, never merged or reranked:

- **Standards:** repo standards plus a smell baseline (mysterious name, long
  method, duplicated logic, refused bequest, and kin); repo rules override
  the baseline; judgement calls only, never tooling-enforced nits.
- **Spec:** does the diff implement the originating spec/requirement
  faithfully — missing, creep, or wrong, quoting the spec line.

Every finding needs proof: the changed hunk, a failing/passing test ref, or
a before/after. Causal disposition decides the outcome: introduced or
worsened behavior gets fixed; pre-existing issues become follow-ups;
inconclusive claims escalate, never silently pass.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Reviewing the summary instead of the candidate | Start from the stable candidate and real refs. |
| Treating every comment as a defect | Investigate the claim and consequence first. |
| Calling self-review independent | Preserve an unavailable capability gap. |
