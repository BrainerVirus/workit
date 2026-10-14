# Verification: checks, verdicts, test audit

Workit separates what an agent *says* from what the CLI *observed*. Only
observed evidence satisfies a gate, and only a session other than the author's
can verify a change.

## `workit check`: observed evidence

```bash
workit check test                       # run the configured "test" check
workit check --name test -- bun test    # same, if argv is exactly the configured command
workit check -- bun test src/foo.test.ts   # ad-hoc: recorded, never satisfies a gate
```

The command runs without a shell (unless `--shell "<cmd>"`), streams its
output, and records exit code, duration, HEAD, worktree tree key and patch-id
as `observer: workit_cli` evidence. The exit code is the command's;
`--timeout <s>` kills the whole process tree.

Configured checks come from a committed `workit.checks.json`:

```json
{ "checks": { "test": "bun test", "lint": "bun run lint" }, "gates": { "testing": "test" } }
```

Without it, Workit detects defaults: package.json `test`/`lint`/`typecheck`/
`check` scripts as `<pm> run <script>`, `go test ./...`, `cargo test`,
`pytest`, `make test`. A check is stale once the worktree changes, or if the
check itself changed it.

## `workit ledger`: decisions, rulings, verdicts

The ledger is a repo-wide, append-only record shared by all worktrees.

```bash
workit ledger decision "Use SQLite for the cache" --why "single-process, no server"
workit ledger ruling "Skip Windows for now" --why "no users" --cost-if-wrong "port later"
workit ledger verdict verified --how "workit check test; drove the CLI" --kind live
workit ledger verdict              # current and accepted verdicts for this branch
workit ledger check [--pr <n>]     # verified, self-reviewed or unreviewed?
workit ledger list --type decision
workit ledger verify-integrity     # rows the CLI did not write, or that changed since
```

Verdict results: `verified`, `tests-verified`, `type-check-only` (passing) and
`blocked`, `failed`. Kinds: `unit`, `live`, `perf`, `review`.
`type-check-only` never proves a behavior change and never satisfies a merge.

**What a judged task needs** (`workit policy assess --judge risk=… behavior=…
product-choice=… plan=…`, or the flat `workit_policy` tool fields):

| Judgment | Needed |
| --- | --- |
| behavior change | an observed passing `workit check test` on the final tree |
| behavior change, risk `normal` | a verdict: by default the author's own (`workit ledger verdict tests-verified --self --how …`), labelled **self-reviewed** in `ledger check` and `pr status`, never verified (it warns when no passing `workit check test` was observed on the head); with the workspace setting `verification: "independent"` ([grants](grants.md)) a verdict from a non-author session |
| risk `high` | an independent `verified` verdict of kind `live`, and a plan before code is written |
| open product choice | the user's answer recorded (`workit ledger decision "<choice>" --why "<reason>"`) before code is written |
| plan needed | the plan written, then cited: `workit policy assess --ref <path>` (an approved limitation waives it) |

Every `policy assess` is recorded in the ledger as a `policy.judged` row
(session, what was sent, the resulting requirements). A session that judged
an open product choice or a needed plan cannot lift it silently: its own
`product-choice=no` or `plan=no` needs `--why "<reason>"`, which the row keeps.

Trivial work judged `risk=trivial behavior=no` needs nothing. Before-write
requirements deny working-tree edits on hosts with a pre-write hook (Claude
Code, OpenCode, Cursor, Pi; advisory on Codex); Markdown, top-level `docs/`,
any `plans/` directory, the cited plan and files outside the checkout stay
writable, and history moves (commit, merge, rebase, stash pop) are never gated.
Shell writes are recognized for redirects, `tee`, `sed -i`/`perl -i`,
`cp`/`mv`/`rm`/`touch`/`mkdir`, `dd` and working-tree git (`apply`, `restore`,
`checkout --`); interpreters and formatters are not detected.

**Author ≠ verifier.** The acting session is `WORKIT_SESSION_ID`, else the
host's own shell session id (Codex `CODEX_THREAD_ID`, OpenCode
`OPENCODE_SESSION_ID`, Pi `PI_SESSION_ID`; see [hosts](hosts.md)). Commits made
with `workit git commit` carry a `Workit-Session:` trailer, and the host hooks
record raw `git commit`s for the session that ran them, so the authoring
session's verdict is never accepted.

A verifier never gets a hand-minted id. Each host derives one:

| Host | Verifier session |
| --- | --- |
| Claude Code, Codex, Cursor | `<lead>:<agent id>` from the SubagentStart hook, passed as `--session` |
| OpenCode | a child session's shell already has `WORKIT_SESSION_ID=<lead>:<child>` (plugin `shell.hook("create.before")`); its `OPENCODE_SESSION_ID` is the child's own id |
| Pi | a supervised worker's shell already has `WORKIT_SESSION_ID=<lead>:<worker session>`; its `PI_SESSION_ID` is the worker's own id |

An independent verdict is refused (`forged_session`) unless its session is
the shell's real host session or a host-derived child of it. The real session
is the host's own variable when it sets one (`OPENCODE_SESSION_ID`,
`PI_SESSION_ID`, `CODEX_THREAD_ID`). Otherwise it is the `WORKIT_SESSION_ID`
the host's hook exported (Claude Code, Cursor, a plain terminal).

A derived child is one of:

- `<lead>:<this session>`, a child naming its own id;
- `<this session>:<agent id>`, on hosts whose subagents share the lead's
  shell (Claude Code, Codex, Cursor).

OpenCode and Pi children run their own shell, so a lead there cannot mint one.
A hand-minted `<lead>-v1` is refused on every host. A `--self` verdict is
never accepted, so it is not checked.

Author matching compares the host session behind a derived id: a child that
committed as `<lead>:<child>` is still the author under its bare `<child>`.

`--as <role>` only keeps verifier ids distinct; it never makes the author
independent. `--session <id>` equal to an author session is refused. An
accepted `--session` is recorded as `sessionSource: flag`, and `ledger check`
prints "named by --session".

On hosts where the id is declared rather than derived (Claude Code, Cursor), a
caller that edits its own environment can still pick any id: there the check
stops casual forgery, not a determined one.

Verdicts are SHA-keyed and carry over a rebase when
the patch-id and diff are unchanged. A dirty tree is refused, also when the
branch is checked out in another worktree. Verdicts and author rows follow a
`git branch -m` rename (through the branch's reflog).

`--supersedes <id>` replaces only a row of the same type, session and branch
(and, for a verdict, the same kind). A same-session verdict that does not
replace that session's own standing failure on the same code prints why and
the `--supersedes` to use. An author's own `failed --self` never blocks an
independent pass, but `ledger check` shows it as a warning.

**Integrity.** Each row the CLI writes carries `prevHash`/`rowHash`, a sha256
chain over the file. `workit ledger verify-integrity` lists rows outside it
(`unsigned`: appended by hand; `hash_mismatch`: edited; `broken_link`: a row
before it was edited or removed) as `unverified_rows`, and `ledger check`
warns about any on the branch. Neither blocks: the chain catches mistakes, it
is not a defense against someone forging rows. Rows written before the chain
existed read as legacy.

## `workit test-audit`

```bash
workit test-audit --diff main           # audit tests touched since main
workit test-audit test/ --fail-on high
workit test-audit --diff --mutate --test-cmd "bun test {files}"
```

Flags tautological and low-value tests (always-true or missing assertions,
mock echoes, snapshots of constants, duplicated bodies, over-mocking, …) with a
suggested independent oracle; `--rule` and `--min-severity` narrow the
report. `--mutate` runs diff-scoped mutation testing on changed lines.

## `workit knowledge lint`

```bash
workit knowledge lint          # exit 1 when anything is found
workit knowledge lint --json
```

Deterministic checks over the agent knowledge files at the repository top:

| Rule | Fails when |
| --- | --- |
| `agents-budget` | `AGENTS.md` (or a `CLAUDE.md` that is not the same file) is over 8 KB |
| `broken-link` | a markdown link, or a backticked path whose first segment exists, points at a missing local file |
| `scaffold-file` | `CODING_STANDARDS.md` or `GLOSSARY.md` holds only headings, comments or placeholders |
| `duplicate-rule` | the same sentence appears in `AGENTS.md` and `CODING_STANDARDS.md` |

It is not a gate by default. Register it as a configured check so
`workit check knowledge` records it:

```json
{ "checks": { "knowledge": "workit knowledge lint" } }
```

`workit doctor` prints a one-line summary (AGENTS.md size and finding count)
that never changes its exit code. The user-invoked `retro` skill uses this
lint as its bloat guard: it proposes fixes ranked by enforcer strength and
applies nothing without your approval.

## Proving it on the real app

The `verify-app` skill generates a project-specific `verify-<app>` skill that
launches, drives and observes your real CLI, web app or API, so verifiers
check behavior rather than reading code.
