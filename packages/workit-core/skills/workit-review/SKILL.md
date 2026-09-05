---
name: workit-review
description: Use when policy requires fresh-context review of a candidate or when an independent correctness and regression check is requested
---

# Review a candidate

Review the real candidate in a stable context. A review is evidence about the
current candidate, not an author's success summary.

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

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Reviewing the summary instead of the candidate | Start from the stable candidate and real refs. |
| Treating every comment as a defect | Investigate the claim and consequence first. |
| Calling self-review independent | Preserve an unavailable capability gap. |
