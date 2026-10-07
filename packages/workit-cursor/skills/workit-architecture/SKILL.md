---
name: workit-architecture
description: Rank cited deepening refactors from churn and ledger friction; never applied unapproved. Use for architecture.
disable-model-invocation: true
---

# Architecture: deepen the modules that cause friction

User-invoked: offer it, never start it yourself. It proposes and grills; it
never refactors without the user's approval. Use the words in
`references/vocabulary.md` exactly (module, interface, depth, seam, adapter,
leverage, locality, the deletion test) and the domain words in `GLOSSARY.md`.

## Deepening

1. **Scope by YAGNI.** A direction the user names wins. Otherwise find hot
   spots: churn (`git log --since=6.months --name-only --format=`, counted per
   file), friction in `workit ledger list --last 200` (failed checks, failed
   verdicts, rulings, `retro:` decisions) and `workit test-audit <paths> --json`
   on the top paths. State the window and the paths in one line.
2. **Settled decisions stand.** Read `GLOSSARY.md`, `CODING_STANDARDS.md` and
   ADRs when present. Never re-litigate an ADR without new evidence.
3. **Explore organically.** A read-only subagent (or you, without one) walks
   the hot spots for cited friction; run the deletion test on every suspect.
4. **Report 3-5 ranked candidates, then stop.** Each one names:
   - files and modules;
   - the friction, with **2 or more cited occurrences** (commit, ledger row,
     PR, test-audit finding); a one-off is not a candidate;
   - the deeper interface: what callers see, what moves behind the seam;
   - what gets simpler and what becomes testable through that interface;
   - **merge danger**: one-way or two-way door, plus blast radius (callers,
     packages, public surface).
   The text list is primary; offer an HTML report only if the host renders one.
5. **Grill the chosen one** as (read the `workit-shape` skill's SKILL.md and follow it) does: numbered questions,
   each with a recommended answer; challenge a weak premise with evidence
   first. Settle the seam, the dependency category, which tests get replaced
   and the migration order.
6. **Hand off on approval.** Several slices: a plan file for
   `workit fanout plan <plan.json>`, with scopes and dependencies
   (read the `workit-fanout` skill's SKILL.md and follow it). One slice: (read the `workit-implement` skill's SKILL.md and follow it). Record the choice with
   `workit ledger decision "architecture: <id>" --why "<evidence>"`; for a
   lasting rejection, offer an ADR so the next run does not suggest it again.

## Instruction files

Restructure AGENTS.md or CLAUDE.md in three escalating passes, **each its own
commit in one PR**, so the user can drop the later ones: remove no-ops;
progressive disclosure into topic files; coding rules to `CODING_STANDARDS.md`
and mechanical rules to checks (`references/instruction-files.md`). Never
scaffold an empty file; `workit knowledge lint` passes after every commit.

## Test sweep

Run `workit test-audit <paths> --json` over the suite or one hot spot and
report findings by module, worst first. On approval, hand them to
(read the `workit-test-audit` skill's SKILL.md and follow it) to replace the bad tests.

## Example

Bad: "The CLI is messy, so I split router.ts in five." Uncited, unapproved.

Good: "1. Check runner (check.ts, evidence.ts). Friction, 3 occurrences:
commits a1b2c3 and d4e5f6 edit both files for one fix; ledger row 41 is a
`check` red on a timeout the runner hid. Deeper interface: `runCheck(spec)`
returns evidence; the timeout moves behind it. Testable: timeouts without a
shell. Merge danger: two-way door, 2 callers in one package. Explore it?"

## Check

```sh
workit knowledge lint   # exit 0 after each instruction-files commit
```
