---
name: workit-deslop
description: Remove AI slop before a PR - dead code, comments that restate the code, filler prose - with a minimal diff and identical behavior. Use for deslop, clean up, slop, tidy before PR, remove dead code, trim the PR body.
---

# Deslop code and prose

Deslop removes; it never changes behavior. Its depth follows the review lane.

1. **Scan first, no agent:** `workit deslop scan --diff [<base>] --json`. It
   classes each added comment `narration`, `marker` (TODO, FIXME, HACK),
   `suppression` (a lint or type disable with no reason), `debug` (stray logs,
   `debugger`, `[DEBUG-` tags) or `allowed`, runs `test-audit` on changed
   tests, and prints the lane and its passes. A marker or a lint/type
   suppression raises `self` to `focused`.
2. **Run the lane's passes** (each lane adds to the one below):
   - `none` (docs only): prose. Cut filler and hedging from the PR body and
     docs; keep real symbol names and before-to-after numbers.
   - `self`: delete every narration, marker and debug finding, plus dead code
     from the repo's tools (`knip`, `ts-prune`, `vulture`, unused-lint rules).
   - `focused`: a fresh-eyes no-comments pass and a test-quality lens. Hand
     the diff, never your verdict, to a fresh reviewer: Claude Code and Codex,
     the `reviewer` agent; OpenCode, a child session; Cursor, a Task subagent
     marked `ROLE: reviewer`; Pi, a supervised worker. It deletes every added
     comment off the keep list and triages `workit test-audit --diff`
     (read the `workit-test-audit` skill's SKILL.md and follow it).
   - `full`: also `workit test-audit --mutate --diff` and one architect
     sketch of the simpler shape, reported, not applied.
3. **The keep list** (everything else goes): a licence header, an external
   quirk (a library, OS or spec behaving oddly), `prettier-ignore` and other
   tool directives, a lint suppression with its reason (`-- <why>`), public
   API docs, an issue or RFC link.
4. **No workaround comments for our own code.** Fix the root in a separate
   `refactor:` commit, or open an issue that carries the explanation and
   delete the comment. A "do not remove" note becomes a test, a type or a
   lint rule.
5. **Record one line per PR** when checks pass again:
   `workit deslop result --removed <n> --reshapes <n> --open <n>` writes
   `deslop: lane focused, -42 lines, 3 reshapes, 1 open` to the ledger.
   Nothing to clean is a valid result (`--removed 0`). When a tracked task
   lists a `pre-pr-cleanup` requirement (≤6.x tasks), this is its evidence.

## Example

Bad: keeping `// increment the counter` above `count += 1`, or deleting
`// eslint-disable-next-line no-await-in-loop -- the API rate-limits parallel calls`.

Good: the scan lists 6 narration, 1 marker and 1 bare `oxlint-disable`; the
lane rises to focused; narration and the marker go, the disable gains its
reason, a fresh reviewer drops two more comments, and a call-order assertion
on an internal mock becomes a result assertion:
`deslop: lane focused, -42 lines, 1 reshapes, 0 open`.

## Check

```sh
workit deslop scan --diff && workit check test && workit deslop result --removed <n>
```
