---
name: workit-review
description: Independent review of a diff, branch or PR - intent fidelity and standards as separate axes, test quality, blast radius - recorded as a non-author verdict. Use for review, code review, check this PR or MR, is this safe, blast radius.
---

# Review independently

Review the candidate, never the author's summary of it. A session that wrote a
commit on the branch cannot record a passing verdict: if that is you, hand the
review to a fresh agent with its own host-derived session: Claude Code and
Codex, the `reviewer` or `verifier` agent (`--session` and `--token` from SubagentStart);
OpenCode, a child session; Pi, a supervised worker. Never hand-mint one such
as `<lead>-v1`: it is refused as `forged_session`.
An author's `--self` verdict reads self-reviewed and never counts as
independent; `type-check-only` never proves a behavior change.
Depth follows the review lane in `workit pr status`: focused reads the diff and
runs its tests; full also drives the real surface (verify-<app>). Review once
per PR after its last push; a second pass on an unchanged head is waste.
A stale verdict showing `reverify: focused (<files>)` in `workit pr status`: re-check only
those files since the judged head and reuse green CI there (no fresh install, no full suite).

1. Pin the candidate: `git rev-parse HEAD`, the base, `git diff <base>...HEAD`;
   for a PR, `workit pr status --json` (checks, unresolved threads).
2. Find the intent: acceptance criteria, spec, PR body, and the recorded
   choices (`workit ledger list --type decision`).
3. Judge two axes separately, never merged or re-ranked:
   - **Spec:** does the diff do what the acceptance says? Missing, creep or
     wrong; quote the line.
   - **Standards:** repo rules first (`CODING_STANDARDS.md` when present),
     then a smell baseline (unclear name, long function, duplicated logic,
     leaky abstraction). Judgment only; lint owns nits.
4. **Tests:** run suites under the heavy-check lease (`workit check test`,
   `workit check --heavy -- <cmd>`); `workit test-audit --diff`. Would each new test fail if the
   behavior broke? Triage the findings (workit-test-audit).
5. **Blast radius:** for each touched contract, caller, config or migration,
   state the one fact it is safe because of and run the proof. Anything
   unproven is labeled UNPROVEN, never assumed safe: `references/impact.md`.
6. Each finding: file:line, severity (blocker, major, minor, nit), evidence
   (hunk, test or command output), concrete fix. Introduced issues get fixed;
   pre-existing ones become follow-ups; inconclusive ones escalate.
7. Record the verdict:
   `workit ledger verdict verified|failed|blocked --kind review --branch <b> --how "<what you ran and read>"`
   under your own session (the one the lead or the hook gave you).
8. **Bound the loop.** A failed verdict gets one fix round and one recheck of
   the changed hunks. Still failing, or stuck: no third round; the lead spawns
   a decider (workit-fanout). A product choice goes to the user.
9. **Harness note** (optional): friction caused by the repo or harness, not
   the change (a flaky fixture, a missing check, a misleading doc or skill
   line), goes on its own `Harness note:` line in the report and any PR
   comment, never as a finding or in the verdict, so a later retro finds it.

## Example

Bad: "Error handling could be improved." (no place, no consequence, no proof)

Good: "blocker - src/pay.ts:88: `catch {}` swallows the gateway's 402, so the
order is marked paid. Repro: `workit check -- bun test pay.test.ts -t declined`
fails with this diff. Fix: rethrow `PaymentDeclined`."

## Check

```sh
workit ledger check --pr <n>   # accepted only when current, passing and independent
```
