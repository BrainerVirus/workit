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
session's verdict is never accepted. A lead starts each verifier with its own
id (`WORKIT_SESSION_ID=<lead>-v<n>`; on Claude Code the SubagentStart hook does
this). `--as <role>` only keeps verifier ids distinct; it never makes the
author independent. `--session <id>` equal to an author session is refused;
any other id is accepted but recorded as `sessionSource: flag`, and
`ledger check` prints "named by --session" so you can tell a claimed verifier
id from one the host set. Verdicts are SHA-keyed and carry over a rebase when
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

## Task context across branches

Each branch has its own implicit task (`workit task status`), and the host
hooks inject that task's compact context on session start and whenever it
changes. Some of that state reaches beyond the branch:

- **Inherited decisions.** A branch also shows the task decisions recorded on
  the branch it was cut from. Workit reads the base from git's reflogs: the
  first entry of the branch's own log, which must be its creation
  ("Created from <base>"). `origin/develop` counts as `develop` when
  `origin` is a remote; a local branch such as `feature/base` keeps its full
  name. For a branch created from HEAD, the base is the branch HEAD moved
  from in the checkout that created it (same commit, same moment), also
  after a rename. The base stays the one the branch was created from:
  rebasing it onto another branch later does not change it. Inherited
  decisions come after the branch's own, each labelled with its
  origin (`"origin": "branch develop"`). Revoked decisions are left out. They
  show before the branch has a task of its own
  (`"objective": "no task on this branch yet"`). They come from the base task
  in any worktree of the repository, so they stay in view when you switch
  between `develop` and a feature branch. Only one level is inherited: a
  branch cut from `feature/a`, which was cut from `develop`, sees
  `feature/a`'s decisions, not `develop`'s. Workit never injects a base task
  that is bound to another host conversation. A branch inherits nothing once
  its creation entry is gone from its reflog (`git reflog expire`, by default
  after 90 days, or `gc`), or when it was fetched rather than created
  locally. For a branch created from HEAD, the same applies once the HEAD log
  no longer holds that checkout.
- **Stale evidence.** Evidence goes stale when the worktree changes after it
  was observed (see [`workit check`](#workit-check-observed-evidence)). The
  context shows the count and the command that lists the stale rows, not the
  evidence ids: `stale evidence: 3; workit task inspect --task <id> --view full`.
- **Workers.** A worker belongs to the task it was assigned on.
  `workit worker cancel <workerId>` and `workit worker report <workerId>` find
  that task from the worker id whatever branch is checked out, so `--task` is
  optional. The rest of the request still goes in `--payload`
  (`{"reason": "…"}` or `{"report": …}`). If the command fails, the error
  names the exact `--task <id>` command to retry with.

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
