---
name: workit-review
description: Independent review of a diff, branch or PR - intent fidelity and standards as separate axes, test quality, blast radius - recorded as a non-author verdict. Use for review, code review, check this PR or MR, is this safe, blast radius.
---

# Review independently

Review the candidate, never the author's summary of it. A session that wrote a
commit on the branch cannot record a passing verdict: if that is you, hand the
review to a fresh agent (Claude Code: the `reviewer` or `verifier` agent).

1. Pin the candidate: `git rev-parse HEAD`, the base, `git diff <base>...HEAD`;
   for a PR, `workit pr status --json` (checks, unresolved threads).
2. Find the intent: acceptance criteria, spec, PR body, and the recorded
   choices (`workit ledger list --type decision`).
3. Judge two axes separately, never merged or re-ranked:
   - **Spec:** does the diff do what the acceptance says? Missing, creep or
     wrong; quote the line.
   - **Standards:** repo rules first, then a smell baseline (unclear name, long
     function, duplicated logic, leaky abstraction). Judgment only; lint owns nits.
4. **Tests:** `workit test-audit --diff`. Would each new test fail if the
   behavior broke? Triage with workit-test-audit.
5. **Blast radius:** for each touched contract, caller, config or migration,
   state the one fact it is safe because of and run the proof. Anything
   unproven is labeled UNPROVEN, never assumed safe: `references/impact.md`.
6. Each finding: file:line, severity (blocker, major, minor, nit), evidence
   (hunk, test or command output), concrete fix. Introduced issues get fixed;
   pre-existing ones become follow-ups; inconclusive ones escalate.
7. Record the verdict:
   `workit ledger verdict verified|failed|blocked --kind review --branch <b> --how "<what you ran and read>"`
   under your own session (the one the lead or the hook gave you). A session
   that wrote the branch is refused, and `--self` never counts as independent.

## Example

Bad: "Error handling could be improved." (no place, no consequence, no proof)

Good: "blocker - src/pay.ts:88: `catch {}` swallows the gateway's 402, so the
order is marked paid. Repro: `workit check -- bun test pay.test.ts -t declined`
fails with this diff. Fix: rethrow `PaymentDeclined`."

## Check

```sh
workit ledger check --pr <n>   # accepted only when current, passing and independent
```
