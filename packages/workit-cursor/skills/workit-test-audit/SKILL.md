---
name: workit-test-audit
description: Find tautological, low-value or noisy tests and replace them with ones that catch real breaks. Use before trusting a green suite, for agent-written tests, test audit, tautology, weak tests, prune or strengthen tests.
---

# Audit tests for tautologies

A tautological test recomputes its expected value the way the code does, so it
passes by construction and can never disagree with the code. Find those and
other low-value tests and triage each one. The audit is advice: never delete
or weaken a test to make it quiet.

## Method

1. Run the audit on the change (or the paths you were asked about):
   `workit test-audit --diff --json` or `workit test-audit <paths> --json`.
   Each finding has file:line, rule, severity, confidence, why and a fix.
   Prose checks are `info`; add `--min-severity info` to see them.
2. Triage every finding with "Name the Break": which wrong production change
   should make this test fail? Then choose one, and say which:
   - Replace: keep the behavior, fix the oracle. Assert the public result
     against an independent expected value (a literal from a worked example,
     the spec, an external contract). Plant the bug you named, watch the new
     test fail, then revert the plant.
   - Keep with a reason: the value is an external contract or the finding is
     wrong. Mark it `// workit-test-audit-ignore <rule> -- <reason>`.
   - Remove: only `assertion-free` or `duplicate-body` tests, and only after
     checking that no other test loses unique behavior with it.
3. Check the replacements catch real breaks: `workit test-audit --mutate --diff`
   (pass `--test-cmd "<runner> {files}"` to run only the related tests). A
   surviving mutant names a change no test notices; add the missing case.
4. Leave untouched tests outside the diff alone; propose that cleanup as its
   own change.

## Example

Bad fix: delete the flagged test, or change its expected value to whatever the
code returns now.

Good fix: `expect(total(items)).toBe(items.reduce(...))` flagged `tautology`; replaced with the worked example `toBe(15)`;
planted `+ 1` in `total()`, saw the new test fail, reverted the plant.

## Check

Every finding is triaged (replaced with a test that failed on a planted bug,
kept with an ignore comment and reason, or removed as above) and the configured
tests are green:

```sh
workit check test
```
