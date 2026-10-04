---
name: workit-debug
description: Find a root cause before patching - build a red-capable deterministic repro first, rank hypotheses, bisect regressions, fix at the root with a regression test. Use for bug, broken, failing, flaky, regression, error, why does.
---

# Debug from a red loop

## Steps

1. **Build the loop before any hypothesis.** One command that is red for the
   user's exact symptom, deterministic, fast and runnable by you:
   `workit check -- <repro>`. Shrink it until it fails in seconds. If the
   symptom only shows on the running app, drive it with the project's
   verify-<app> skill. No loop yet? Building it is the task; do not guess-patch.
2. **Read the failure, not the summary:** the full error, the failing value,
   and every caller on its path.
3. **Rank three to five falsifiable hypotheses**, likeliest first. Test one at
   a time with the loop or a tagged log line (`[DEBUG-<id>]`, removed at the
   end with one grep). Keep a short hypothesis log so a dead idea stays dead.
4. **Regression? Bisect it:** `git bisect start <bad> <good>` then
   `git bisect run <repro>`. The first bad commit names the cause.
5. **Fix at the root**, the one place every failing caller passes through.
   Add a regression test at a seam that exercises the real bug pattern; if no
   such seam exists, report that as a finding.
6. **Stop rule:** after three dead hypotheses, write down what is measured and
   what is inferred, widen the loop, or ask for the one fact only the user has.

Every shipped line traces to evidence from the loop. A "might help" retry or
guard is a hypothesis, not a fix.

## Example

Bad: "Probably a race; added a retry." (no repro, nothing measured)

Good: "Repro: `workit check -- bun test lock.test.ts -t stale` red 10/10.
H1 dead pid not reclaimed - confirmed: `kill(pid, 0)` throws EPERM for another
user's pid and we treated it as dead. Fix: EPERM means alive. Loop green 10/10;
regression test pins the EPERM case."

## Check

```sh
workit check -- <repro>   # red before the fix, green after
workit check test
```
