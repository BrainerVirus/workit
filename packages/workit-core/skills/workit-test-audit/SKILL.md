---
name: workit-test-audit
description: Use when tests may be tautological, low-value or noisy, before trusting a green suite, when reviewing tests an agent wrote, or when asked to clean up, prune or strengthen tests
---

# Audit tests for tautologies

A tautological test recomputes its expected value the way the code does, so it
passes by construction and can never disagree with the code. Find those and
other low-value tests, then remove or replace them. Never delete blind.

## Method

1. Run the static audit on the change (or on paths you were asked about):
   `workit test-audit --diff --json` or `workit test-audit <paths> --json`.
   Each finding has file:line, rule, why, and a suggested fix.
2. Triage every finding with "Name the Break": which wrong production change
   should make this test fail? Then pick one:
   - Replace when the behavior matters but the oracle is wrong: assert the
     public result against an independent oracle (a literal from a worked
     example, the spec, an external contract).
   - Remove when the test cannot fail for a real bug: `always-true`, a mock
     asserted on its own return, a snapshot of a constant, a byte copy of a
     generated file, a duplicate body.
   - Keep with a reason when the value is an external protocol constant;
     mark it `// workit-test-audit-ignore <rule> -- <reason>`.
3. Prose `toContain` checks: assert what the text drives (a field, an exit
   code, a decision) or a short stable token, not wording.
4. Verify the replacements catch real breaks with diff-scoped mutation:
   `workit test-audit --mutate --diff`. A surviving mutant names a change
   no test notices; add the missing case, not a weaker assertion.
5. Keep cleanup of untouched tests out of a feature diff; propose it as its
   own change.

## Completion

No high-severity findings remain on the diff, and no mutant survives on the
changed lines (or each survivor is recorded as an accepted limitation):

```sh
workit test-audit --diff --fail-on high && workit test-audit --mutate --diff
```
