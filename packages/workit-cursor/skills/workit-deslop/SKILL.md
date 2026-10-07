---
name: workit-deslop
description: Remove AI slop before a PR - dead code, comments that restate the code, filler prose - with a minimal diff and identical behavior. Use for deslop, clean up, slop, tidy before PR, remove dead code, trim the PR body.
---

# Deslop code and prose

Deslop only removes lines; it never changes behavior or moves logic. A change
that wants new behavior is its own change.

1. **Find it with tools first.** The repo's dead-code and lint tools on the
   branch diff (for example `knip`, `ts-prune`, `vulture`, `cargo udeps`, or
   the linter's unused rules), then read the diff:
   `git diff <base>...HEAD`.
2. **Code.** Delete unused helpers and exports, stub references, debug
   leftovers (`[DEBUG-` tags, stray logs), and comments that restate the next
   line. Keep comments that say *why* (a constraint, a workaround with its
   link), license headers and tool directives.
3. **Prose** (PR body, spec, docs): cut filler and hedging, keep real symbol
   names and before-to-after numbers. One doc, one purpose.
4. **Re-run the checks** and report lines removed, not lines written. Nothing
   to clean is a valid result: say what you checked ("0 removals; ran knip and
   read the diff"). When a tracked task lists a `pre-pr-cleanup` requirement (≤6.x tasks),
   record this result as its evidence.

## Example

Bad: deleting `// retry: the gateway drops the first request after idle (#412)`
because "comments die".

Good: deleting `// increment the counter` above `count += 1`, an unused
`formatLegacyDate` export reported by knip, and two hedging paragraphs from the
PR body: "-34 lines, behavior unchanged, `workit check test` exit 0".

## Check

```sh
workit check test && git diff --stat <base>...HEAD
```
