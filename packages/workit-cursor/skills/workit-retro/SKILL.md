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

1. **Scope.** Default: this repository's last ~10 sessions, or its branches
   since the last retro. State the window in one line.
2. **Read through workit, cheapest first.** Every finding cites these:
   - `workit ledger list --last 200`: rulings (ambiguities the agent had to
     settle), failed or self verdicts, handoffs, check runs, CI reruns.
   - `workit pr status --pr <n>` for each recent PR: threads, failing checks.
   - `git log --oneline -50`, plus reverts and fixups after review.
   - `workit knowledge lint`: today's AGENTS.md and need-based files.
   - Session transcripts **only if the user opts in**, and only this
     workspace's (`references/sources.md`). Never read other projects.
3. **Group into classes.** Navigation cost (many searches before the right
   file, a stale doc followed), repeated mistakes, workarounds (a hand-run
   command where a verb exists, a skipped step), unstable checks (the same
   `workit check <name>` red then green with no change). A class needs **2 or
   more cited occurrences**; a one-off is not a learning.
4. **Name the strongest enforcer that works**, top first:
   1. architecture or types (the mistake cannot be written)
   2. a lint rule
   3. a configured check (`workit.checks.json`, run by `workit check <name>`)
      or a CI job
   4. a test
   5. `CODING_STANDARDS.md` (a judgment call the reviewer reads)
   6. an AGENTS.md pointer (navigation only)

   A mechanical rule gets a check, not prose: a check can fail, a sentence
   cannot. For rungs 1-4 the proof is that the new enforcer fails on the
   cited past mistake. A rule whose mistake can no longer happen is deleted.
5. **Upstream.** When a workit skill, verb or hook caused the friction,
   propose an issue or PR on BrainerVirus/workit. Never fork a local copy.
6. **Bloat guards.** AGENTS.md stays within 8 KB: each addition names what it
   removes. Create `CODING_STANDARDS.md` or `GLOSSARY.md` only in the same
   edit as its first real entry, never as a scaffold. Edit steering text by
   `references/steering.md`; `workit knowledge lint` passes after the slice.
7. **Report one ranked list, then stop:** Accepted (proposed), Backlog,
   Dropped, each with its citations, enforcer and reason. Each approved item
   becomes a normal slice (workit-implement, then workit-ship), a tracker
   issue, or `.out-of-scope/<concept>.md` when rejected and likely to return.

## Example

Bad: "Agents seem lost in the build. Added 'read the build docs carefully' to
AGENTS.md." One vague occurrence, no citation, a no-op line, auto-applied.

Good: "Navigation, 3 occurrences (rulings 12 and 19; PR #88 thread): agents
looked for check names in package.json and missed `workit.checks.json`.
Enforcer: AGENTS.md pointer (rung 6), +74 bytes, removing the stale Commands
paragraph (-210). Unstable check, 2 occurrences (ledger: `e2e` red then green
on one SHA): rung 3, retry policy in the check, plus a debug slice. Approve?"

## Check

```sh
workit knowledge lint   # exit 0 before and after each approved slice
```
