---
name: workit-retro
description: Find repeated friction in recent sessions; propose cited fixes ranked by enforcer strength, never applied. Use for retro.
disable-model-invocation: true
---

# Retro: turn repeated friction into enforcers

User-invoked: offer it, never start it yourself. Run it after a session, PR,
stack or fan-in, including ones that went well; a smooth session still shows
where agents searched too long, worked around a tool or re-ran a check. Retro
proposes and stops. Nothing changes until the user approves.

1. **Scope.** Default: this repository's work since the last retro (its
   `retro:` row in `workit ledger list --type decision`), else the last ~10
   sessions. State the window in one line.
2. **Read through workit, cheapest first.** Every finding cites these:
   - `workit ledger list --last 200`: rulings, failed/self verdicts, handoffs,
     check runs, CI reruns, `skill.loaded` rows (skipped skills: routing).
   - `workit pr status --pr <n>` for each recent PR: threads, failing checks.
   - `git log --oneline -50`, plus reverts and fixups after review.
   - `workit knowledge lint`: today's AGENTS.md and need-based files.
   - Session transcripts **only if the user opts in**, and only this
     workspace's (`references/sources.md`). Never read other projects.

   Cite by location (ledger row, PR, commit, session file and line). Never
   copy secrets, tokens or personal data from any source into the report.
3. **Group into classes.** Navigation cost (many searches before the right
   file, a stale doc followed), repeated mistakes, workarounds (a hand-run
   command where a verb exists, a skipped step), unstable checks (the same
   `workit check <name>` red then green with no change). A class needs **2 or
   more cited occurrences**; a one-off is not a learning.
4. **Name the strongest enforcer that works**, strongest first: architecture
   or types (the mistake cannot be written) > lint rule > configured check
   (`workit.checks.json`, `workit check <name>`) or CI job > test >
   `CODING_STANDARDS.md` (judgment the reviewer reads) > AGENTS.md pointer
   (navigation only). A mechanical rule gets a check, not prose: a check can
   fail, a sentence cannot. From types to test, the proof is that the new
   enforcer fails on the cited past mistake. A rule whose mistake can no
   longer happen is deleted.
5. **Upstream.** When a workit skill, verb or hook caused the friction,
   propose an issue or PR on BrainerVirus/workit. Never fork a local copy.
   The issue shows the workit behavior in a minimal synthetic reproduction:
   no private repo name, path, code, ledger text, PR or thread quote, or
   transcript. Show the exact draft body; file it only after the user approves.
6. **Bloat guards.** AGENTS.md stays within 8 KB: each addition names what it
   removes. Create `CODING_STANDARDS.md` or `GLOSSARY.md` only in the same
   edit as its first real entry, never as a scaffold. Edit steering text by
   `references/steering.md`; `workit knowledge lint` passes after the slice.
7. **Report one ranked list, then stop:** Accepted (proposed), Backlog,
   Dropped, each with its citations, enforcer and reason. Each approved item
   becomes a slice to build (read the `workit-implement` skill's SKILL.md and follow it) and ship (read the `workit-ship` skill's SKILL.md and follow it), a tracker
   issue, or `.out-of-scope/<concept>.md` when rejected and likely to return.
   Record the user's answer so the next retro starts there:
   `workit ledger decision "retro: <accepted ids>" --why "<window>"`.

## Example

Bad: "Agents seem lost in the build. Added 'read the build docs carefully' to
AGENTS.md." One vague occurrence, no citation, a no-op line, auto-applied.

Good: "Navigation, 3 occurrences (rulings 12, 19; PR #88 thread): agents sought
check names in package.json, missing `workit.checks.json`. Enforcer: AGENTS.md
pointer, +74 bytes, minus the stale Commands paragraph (-210). Unstable check,
2 occurrences (ledger rows 31, 44: `e2e` red then green on one SHA): a debug
slice to fix the check. Approve?"

## Check

```sh
workit knowledge lint   # exit 0 before and after each approved slice
```
