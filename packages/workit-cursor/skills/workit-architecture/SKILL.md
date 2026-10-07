---
name: workit-architecture
description: Rank cited deepening refactors from churn and ledger friction; never applied unapproved. Use for architecture.
disable-model-invocation: true
---

# Architecture: deepen the modules that cause friction

User-invoked: offer it, never start it yourself. It proposes and grills; it
never refactors without the user's approval. Use the words in
`references/vocabulary.md` exactly and the domain words in `GLOSSARY.md`.

## Deepening

1. **Scope by YAGNI.** A direction the user names wins. Otherwise find hot
   spots: churn (`git log --since=6.months --name-only --format=`, counted per
   file, skipping lockfiles, version-bump manifests, generated files, docs and
   `chore(release)` commits), friction in `workit ledger list --last 200`
   (failed checks and verdicts, rulings, `retro:` decisions) and
   `workit test-audit <paths> --json`. State the window and paths in one line.
2. **Settled decisions stand.** Read `GLOSSARY.md`, `CODING_STANDARDS.md` and
   ADRs when present. Never re-litigate an ADR without new evidence.
3. **Explore organically.** A read-only explorer (Claude Code: Explore; or
   you) walks the hot spots under the limits in `references/vocabulary.md`
   and returns cited friction. Run the deletion test on every suspect.
4. **Report 3-5 ranked candidates, then stop and wait for approval.** Each:
   - files and modules;
   - the friction, with **2 or more cited occurrences** (commit, ledger row,
     PR, test-audit finding); a one-off is not a candidate;
   - an interface sketch: what callers see, what moves behind the seam;
   - what gets simpler and what becomes testable through that interface;
   - **merge danger**: one-way or two-way door, plus blast radius (callers,
     packages, public surface).
   The text list is primary; offer an HTML report only if the host renders one.
5. **Grill the chosen one**: numbered questions, each with a recommended
   answer; challenge a weak premise with evidence first. Settle the interface,
   the seam, the tests to replace and the migration order; a module named for
   a new concept gets its glossary entry (read the `workit-shape` skill's SKILL.md and follow it).
6. **Hand off on approval.** Several slices go into a plan for
   `workit fanout plan <plan.json>`, with scopes and dependencies
   (read the `workit-fanout` skill's SKILL.md and follow it). One slice goes to a build (read the `workit-implement` skill's SKILL.md and follow it). Record the
   choice with `workit ledger decision "architecture: <id>" --why "<why>"`;
   offer an ADR for a lasting rejection so the next run does not repeat it.

## Instruction files

Restructure AGENTS.md or CLAUDE.md in three escalating passes, **each its own
commit in one PR**, so the user can drop the later ones: remove no-ops;
progressive disclosure into topic files; coding rules to `CODING_STANDARDS.md`
and mechanical rules to checks. No commit adds a `workit knowledge lint`
finding. Never scaffold an empty file (`references/instruction-files.md`).

## Test sweep

Run `workit test-audit <paths> --json` over the suite or one hot spot and
report findings by module, worst first. On approval, the bad tests are
replaced (read the `workit-test-audit` skill's SKILL.md and follow it).

## Example

Bad: "The CLI is messy, so I split router.ts in five." Uncited, unapproved.

Good: "1. Check runner (check.ts, evidence.ts), 3 occurrences: commits a1b2c3
and d4e5f6 edit both for one fix; ledger row 41 is a `check` red on a hidden
timeout. Sketch: `runCheck(spec)` returns evidence, the timeout behind it, so
timeouts test without a shell. Two-way door, 2 callers in one package."

## Check

```sh
workit knowledge lint   # no new finding after each instruction-files commit
```
