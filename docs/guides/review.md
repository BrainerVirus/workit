# Review depth: deslop by lane

Deslop is the last cleanup before a PR: it removes comments that restate the
code, dead code, debug leftovers and filler prose, and never changes
behavior. How deep it goes follows the branch's
[review lane](verification.md#review-lanes) (`none`, `self`, `focused`,
`full`).

## `workit deslop scan`

```bash
workit deslop scan --diff              # the branch diff against its base
workit deslop scan --diff main --json  # an explicit base; the JSON envelope
workit deslop scan --lane self         # assume a lane instead of computing it
```

The scan reads the branch diff (committed, staged, unstaged and untracked
files) and needs no agent; it runs in well under two seconds. Each comment
an added line carries gets one class:

| Class | What it is |
|---|---|
| `narration` | Any comment not on the keep list: it restates or narrates the code |
| `marker` | `TODO`, `FIXME`, `XXX`, `HACK`, `TBD` |
| `suppression` | A lint or type disable without a reason: `eslint-disable`, `oxlint-disable`, `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `noqa`, `type: ignore`, `NOLINT`, coverage ignores |
| `debug` | `console.log`, `debugger`, `dbg!`, `breakpoint()`, `[DEBUG-n]` tags |
| `allowed` | On the keep list, with the entry it matched |

The keep list follows pstack's "Comment Sicko": a licence header, an external
quirk (a library, OS or spec behaving oddly), `prettier-ignore` and other
formatter or tool directives, a lint suppression with its reason
(`// eslint-disable-next-line no-await-in-loop -- the API rate-limits
parallel calls`), public API docs (a doc comment on an export or a member of
an exported type), and an issue or RFC link. Comments are found by a lexer
that skips strings, template literals and regex literals, for `//`, `/* */`,
`#` and `--` languages; Markdown and other prose files are not scanned.

The scan also runs `workit test-audit` on the changed test files and prints
the lane with the passes it asks for. A new marker or lint/type suppression,
justified or not, raises a `none` or `self` lane to `focused`: it hides a
check, so a second pair of eyes reads it. A formatter directive does not.

## Passes by lane

Each lane runs its own passes and every pass of the lanes below it.

| Lane | Passes |
|---|---|
| `none` | Prose: cut filler from the PR body, docs and commit messages |
| `self` | The scan, then delete every narration, marker and debug finding; dead code from the repo's own tools (`knip`, `ts-prune`, `vulture`) |
| `focused` | A fresh-eyes no-comments pass and a test-quality lens (`workit test-audit --diff`, triaged) |
| `full` | `workit test-audit --mutate --diff` and one architect sketch of a simpler shape, reported, not applied |

The fresh-eyes pass goes to a reviewer that did not write the change, through
each host's own mechanism: the `reviewer` agent on Claude Code and Codex, a
child session on OpenCode, a Task subagent marked `ROLE: reviewer` on Cursor,
and a supervised worker on Pi. It gets the diff and the keep list, not the
author's opinion of them.

A workaround comment for our own code is not kept: the root gets fixed in a
separate `refactor:` commit, or an issue carries the explanation and the
comment goes. A "do not remove" note becomes a test, a type or a lint rule.

## Test-quality rules

`workit test-audit` adds two rules that the test-quality lens reads:

- `mock-call-order`: a call count or call order asserted on a double that
  replaces the code under test's own module (`mock.module("../src/x")`,
  `jest.mock`, `vi.mock`, or `spyOn` on an internal import), and call order
  on any double. A count on an injected boundary double (a retry against a
  mail gateway) is left alone.
- `private-access`: a test that reads `obj._private` or `obj["_private"]`, or
  imports a test-only export (`__testing`, `fooForTesting`, `_internal`).

Mute one line with `// workit-test-audit-ignore <rule> -- <reason>`.

## One result line per PR

```bash
workit deslop result --removed 42 --reshapes 3 --open 1
# deslop: lane focused, -42 lines, 3 reshapes, 1 open
```

`deslop result` records the line in the ledger as a `deslop.result` row keyed
to the branch head (`workit ledger list` shows it). Without `--lane` it uses
the lane the scan computes. `--removed 0` is a valid result.
