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

A verifier never names its own session. Each host gives it one:

| Host | Verifier session |
| --- | --- |
| Claude Code, Codex | `<lead>:<agent id>` and a token from the SubagentStart hook (`workit:verifier`, `workit:reviewer`; Codex `workit-verifier`, `workit-reviewer`), passed exactly as `--session` and `--token`; any other Codex verifier passes `--as verifier` |
| OpenCode | a child session's shell already has `WORKIT_SESSION_ID=<lead>:<child>` (plugin `shell.hook("create.before")`); its `OPENCODE_SESSION_ID` is the child's own id |
| Pi | a supervised worker's shell already has `WORKIT_SESSION_ID=<lead>:<worker session>`; its `PI_SESSION_ID` is the worker's own id |
| Cursor, CI, a plain terminal | declared: `WORKIT_SESSION_ID=<lead>:verifier-<random hex>` (Cursor's hook cannot reach a subagent) |

An independent verdict is refused (`forged_session`) unless its session is
one of these:

- the shell's own session: the host's variable when it sets one
  (`OPENCODE_SESSION_ID`, `PI_SESSION_ID`, `CODEX_THREAD_ID`), else the
  `WORKIT_SESSION_ID` Claude Code's SessionStart exported with
  `WORKIT_HOST=claude_code`;
- `<lead>:<this session>`, a child naming its own host session (only where the
  host sets the variable);
- `<lead>:<agent id>` that this lead's SubagentStart hook issued (Claude Code,
  Codex). The hook records each id it issues per lead in the user's Workit
  state dir (`issued/`, the newest 64 per lead), so a verifier can record its
  verdict from any repository the lead delegated to, and a `<lead>:v1` the lead made up
  is refused. The same holds for a declared `WORKIT_SESSION_ID=<lead>:<x>`
  under any `WORKIT_HOST` other than `cli`.

An issued id is bound to its subagent: the hook mints a random token, hands it
only to that subagent in its SubagentStart context, and stores only the
token's sha256. `ledger verdict` accepts the id only with `--token <token>`
(or `WORKIT_SESSION_TOKEN`), so a lead or sibling that read the id in the
ledger cannot record under it (`unbound_session`), nor supersede that
reviewer's failure. The row then carries `sessionBound: true`. An id issued
by a hook older than tokens (`workit-issued-sessions/2` records) is still
accepted without one; `workit doctor` reports that plugin as out of date.

On a host, `--session` takes only an issued id. Naming the shell's own
session (`--session <lead>` on Claude Code, an OpenCode child's
`<lead>:<child>`, a Pi worker's id, a Codex thread id) is refused as
`session_flag`: drop `--session`, the shell's own session already acts. Every
recorded verdict prints the gates' reading of its branch (`gate: <branch>
accepted` or `not accepted (<reasons>)`; `data.gate` in JSON), so a verdict
that does not count is never silent.

An issued id never authors code: `workit git commit` refuses it
(`judge_session`) and runs the same claim check as a verdict.

A made-up `<lead>-v1` is refused as `--session` on Claude Code, Codex,
OpenCode and Pi, and as `WORKIT_SESSION_ID` where the host sets its own
variable (Codex, OpenCode, Pi). A `--self` verdict is never accepted, so it
is not checked.

With no host session at all (CI, a plain terminal, Cursor's prefixed
commands: no host variable and no `WORKIT_HOST`), the session is only
declared: `--session X` and `WORKIT_SESSION_ID=X` are the same declaration and
both are accepted. Nothing there can tell a verifier from the author but the
id itself.

Author matching also catches a derived form: a bare host session and its
`<lead>:<session>` form are the same author (an OpenCode child that committed
as `<lead>:<child>` and judges as `<child>`). Two derived ids never match on a
shared last segment.

`--as <role>` only keeps verifier ids distinct; it is checked by the session it
derives from and never makes the author independent. `--session <id>` equal
to an author session is refused. An accepted `--session` is recorded as
`sessionSource: flag`, and `ledger check` prints "named by --session".

A host that always sets its own variable (OpenCode, Pi, Codex) but is named
by `WORKIT_HOST` without it (`env -u OPENCODE_SESSION_ID`) cannot vouch for
any id: the verdict is refused.

If a well-formed `<lead>:<agent id>` is refused and no hook in the workspace
has ever recorded an issued id, the refusal names the likely cause. The CLI
and the host plugin update separately, and a plugin hook older than the CLI
records nothing. Update the plugin (`claude plugin update workit@workit`, or
reinstall the Codex plugin) and relaunch the verifier. `workit doctor`
reports the same skew as `hook_issued_sessions`.

Limits (the check stops casual forgery, not a determined one; see
[the host parity table](../agents/hosts.md#host-parity)):

- Claude Code: the lead's own session is the declared `WORKIT_SESSION_ID`.
  A caller can still export a colon-less id inline, including the old
  documented `<lead>-v<n>` form. `CLAUDE_CODE_SESSION_ID` could close this
  gap; it is not used yet.
- OpenCode, Pi, Codex: the host variable is checked, but a caller that removes
  both it and `WORKIT_HOST` from its environment looks like a plain terminal,
  and one that sets a host's variable itself (`OPENCODE_SESSION_ID=x`) is
  believed.
- Any host: unsetting `WORKIT_HOST` or overriding it to `cli`, with no host
  variable, makes a plain terminal, where any id is declared.
- Cursor, CI and a plain terminal are declared by design; Cursor's hook
  cannot reach a subagent, so it issues no ids or tokens.
- Claude Code, Codex: the issued-id record is plain files in the user's state
  dir. A caller that writes there deliberately can mark any id as issued, or
  rewrite a record to the token-less `/2` form. The token itself sits in the
  subagent's transcript, which a caller that reads the host's transcript
  files can find.

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
before it was edited or removed; `duplicate_id`: a copy of an earlier row) as
`unverified_rows`, and `ledger check` warns about any on the branch. Rows
written before the chain existed read as legacy.

Appends are never refused, but every verdict gate (`pr merge`, `stack land`,
`pr status`, `ledger verdict`, the stop hook, fanout checks) reads the chain.

While any row anywhere in the ledger reads `hash_mismatch` or `broken_link`
(an edited row, or one removed or moved: honest appends never produce
either), no verdict is accepted at all: reason `ledger_tampered`. `workit
ledger verify-integrity` lists the broken rows. To repair, once the edit is
understood, move the ledger file aside (`mv <ledger> <ledger>.tampered-<date>`;
the unblock names the path) and record the verdicts again.

These verdicts are never accepted as independent:

- a verdict row outside the chain, legacy rows included: reason `unsigned`,
  `hash_mismatch`, `broken_link` or `duplicate_id`;
- a `--session` verdict recorded on a host (Claude Code, Codex, OpenCode, Pi)
  whose id no SubagentStart hook issued, or a `<lead>:<x>` environment id on
  a declared host (Claude Code, Cursor or any `WORKIT_HOST` but `cli`) that
  none issued: reason `unissued_session`;
- such an issued id recorded without its token (an older CLI, or another
  session reusing it): reason `unbound_session`.

`--session` from CI or a plain terminal, `--as`, and an OpenCode, Pi or Codex
shell's own session stay accepted. A row the gate cannot trust also cannot
retire another: its `--supersedes` is ignored. A failure counts as the
author's own only when chained rows written before it made its session an
author, so authorship gained afterwards (a forged row, a commit or empty amend
under the reviewer's id, a trailer) never discounts it. An unverified
`stack.restacked` row never carries a pass onto new code. The chain is a
keyless sha256: it stops a row appended, edited, removed or moved by hand,
not someone who recomputes the hashes, deletes the newest rows, or moves the
whole ledger aside.

The ledger file is created `0600`; an older, wider one is tightened on the
next append (POSIX). On OpenCode, Pi and the MCP server, which run Workit in
their own process, a held ledger lock (network filesystems only) is waited
on for at most 250 ms and returns `busy`; the CLI waits up to 5 s.

**Merges.** `workit pr merge` records `pr.merge.intent` before the forge
write (a merge that cannot record it never starts), `pr.merged`
(`verified: false`) as soon as the forge accepts the merge, then confirms it
with `pr.merge.verified`. If the merge call errors although the forge merged,
`pr status` reads the intent. If the forge cannot be read back, the merge
fails as `merge_unverified` naming the `pr.merged` row, and `pr status`, the
stop hook and `verify-delivery merged` still see the merge. A confirmation row
that cannot be written is printed (`confirmed.error` in JSON).

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
