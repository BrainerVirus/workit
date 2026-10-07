# PR body

Write the body so a reviewer can judge the change fast. Use three sections, in
this order, and nothing else the reviewer has to read.

1. **Summary:** the smallest visual that makes the change clear (pseudocode, a
   call tree, a file tree, a Mermaid diagram or one diff hunk), with a sentence
   or two in the domain's words.
2. **Evidence:** before and after, observed, never asserted. Name the checks
   recorded on the head SHA (`workit ledger list --branch <b> --type check`)
   and the verdict (`workit ledger check --branch <b>`), or a command with its
   output: red before the change, green after.
3. **Merge danger:** one line. One-way door (hard to undo: a migration, a
   published format, a release) or two-way door (a revert undoes it), plus
   the blast radius: who or what breaks if it is wrong (the review skill's
   impact reference lists the surfaces to check).

## Example

```md
## Summary
Ship skill, step 5: "fix CI" → "reproduce with `workit check`, then fix the root cause"

## Evidence
- `check` row: `test` exit 0 on 4be1c2d (`workit ledger list --branch docs/ship-ci --type check`)
- `verdict` row: verified, kind review, non-author session (`workit ledger check --branch docs/ship-ci`)

## Merge danger
Two-way door: skill text only, a revert restores it. Blast radius: agents that babysit PRs, on every host.
```
