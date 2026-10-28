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

The command runs without a shell (unless `--shell "<cmd>"`) and records exit
code, duration, HEAD, worktree tree key and patch-id as `observer: workit_cli`
evidence. The exit code is the command's; `--timeout <s>` kills the whole
process tree. It prints only the last 60 lines of the output (a failure's
tail, never its head) and one summary line with the check name, exit code,
duration and `log: <path>` to the full redacted log; `--full` streams the whole
output as it runs instead.

An ad-hoc run under a configured name (`--name test -- <other cmd>`) says
before it runs that it will not satisfy that name's gate.

Configured checks come from `.workit/checks.json`, which lives in the
self-ignoring `.workit/` directory so it adds nothing to your repo root or
`.gitignore`:

```json
{ "checks": { "test": "bun test", "lint": "bun run lint" }, "gates": { "testing": "test" } }
```

Without it, Workit detects defaults: package.json `test`/`lint`/`typecheck`/
`check` scripts as `<pm> run <script>`, `go test ./...`, `cargo test`,
`pytest`, `make test`. A check is stale once the worktree changes, or if the
check itself changed it.

A linked worktree (a `workit fanout worktree create` slice, an agent's
worktree) without its own `.workit/checks.json` reads the main checkout's, and
runs the commands from the worktree.

A root `workit.checks.json` from older versions is still read when
`.workit/checks.json` is absent, and `workit check` prints a one-line `note:`
that it moved. `.workit/checks.json` wins when both exist. `workit doctor` lists
the legacy file, and `workit doctor --fix` moves it into `.workit/`.

### Heavy commands and the lease

Heavy work (tests, builds, lint, typecheck, installs, image builds) shares one
machine-wide lease, so parallel agents cannot exhaust the machine's memory and
CPU ([delivery guide](delivery.md#heavy-checks-share-the-machine)). Run heavy
commands through `workit check`, never with a hand-made `flock`:

```bash
workit check test                    # test, build and typecheck take the lease
workit check --heavy -- npx jest     # an ad-hoc heavy command
workit lock status                   # who holds the lease
workit lock wait --timeout 300       # wait for a free slot without taking it
workit check test --no-lease --reason "machine idle, bisecting a hang"
```

The shell hook catches the raw form, after every other Workit gate (branch
policy, raw git, the before-write and live-session gates) passed on it. Those
gates also judge what `workit check … -- <cmd>` runs, so wrapping a command
never gets it past them.

- **One heavy command** (`npx jest`, `npm run test:ci`, `cargo test`, `docker
  build`, also behind `flock`, `nice`, `env`, `timeout` or `bash -c '<one
  command>'`) runs as `workit check --heavy -- <cmd>` on Claude Code, OpenCode
  and Pi. In a Claude Code or OpenCode shell the CLI caps the lease wait at
  100 s, so a busy lease answers before the shell tool's own 120 s timeout
  (`--wait <s>` overrides it); an older CLI waits its configured default. The
  rewrite uses only flags every supported CLI accepts. Codex and Cursor
  cannot rewrite a command, so the hook denies it there and names that exact
  command.
- **A chain with heavy parts** (`git status && make test && touch x`, `cd web
  && npm test`, a pipe, a redirect) is denied on every host. The reason names
  each heavy part's lease command (`workit check --heavy -- make test`); run
  the other parts as their own commands. The hook never wraps a chain in `bash
  -c`.
- **A host rule decides first.** If a host deny or ask rule names the heavy
  command, or the only allow that would cover the wrapper is one for `workit`,
  the command runs as typed, outside the lease, with a one-line note. Wrapping
  must never change what the host would have done with it.
- **Not gated:** watch modes (`--watch`, `tsc -w`), dev servers and
  storybook (`npm run dev`, `start`, `serve`, `vite`, `next dev`), and any
  command outside a git checkout.

The catalog is built in (`workit lock heavy list`). To add a command, use
`workit lock heavy add 'mvn verify'` (machine-wide, under the state dir), or
list it in the repo's checks config under `resources.heavyCommands`. A
pattern is words matched as a prefix of the command line, with `*` inside a
word matching anything (`task test:*`). `workit lock heavy test -- <cmd>` says
whether the hook gates a command. The hook leaves commands alone when no
`workit` is on PATH, and `WORKIT_HEAVY_GATE=0` in the host's environment turns
the gate off for that host. `--no-lease` needs `--reason`, recorded on the run
as `noLease`.

## `workit ledger`: decisions, rulings, verdicts

The ledger is a repo-wide, append-only record shared by all worktrees.

```bash
workit ledger decision "Use SQLite for the cache" --why "single-process, no server"
workit ledger ruling "Skip Windows for now" --why "no users" --cost-if-wrong "port later"
workit ledger verdict verified --how "workit check test; drove the CLI" --kind live
workit ledger verdict              # current and accepted verdicts for this branch
workit ledger check [--pr <n>]     # verified, self-reviewed or unreviewed?
workit ledger decision "Keep the flag off" --by decider --why "reversible" --view "A: on" --view "B: off"  # a tie-breaker agent's call: never the user's answer, never a verdict
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
| risk `normal`, under the default `verification: "proportional"` | the verdict the [review lane](#review-lanes) asks for, whatever the behavior-change judgment says: the diff decides (lane `none` needs none) |
| behavior change, risk `normal`, under `verification: "self"` or `"independent"` | under `self` the author's own (`workit ledger verdict tests-verified --self --how …`), labelled **self-reviewed** in `ledger check` and `pr status`, never verified (it warns when no passing `workit check test` was observed on the head); under `verification: "independent"` ([grants](grants.md)) a verdict from a non-author session |
| risk `high` | an independent `verified` verdict of kind `live`, and a plan before code is written |
| open product choice | the user's answer recorded (`workit ledger decision "<choice>" --why "<reason>"`) before code is written |
| plan needed | the plan written, then cited: `workit policy assess --ref <path>` (an approved limitation waives it) |

### Review lanes

Under `verification: "proportional"` (the default when a workspace sets none)
Workit computes a review lane from the diff of the branch against its base
(`packages/workit-core/src/core/policy/lane.ts`, thresholds in
`LANE_THRESHOLDS`). `workit pr status` (`verdict.lane` in `--json`) and
`workit policy assess` (`lane`) show it with the reason.

| Lane | When | Needs |
| --- | --- | --- |
| `none` | only docs (`.md`, `.mdx`, `.rst`, `.adoc` outside agent instructions, or a bare `LICENSE`/`CHANGELOG`; a `.txt` such as `requirements.txt` or `CMakeLists.txt` is behavior), comment, whitespace or formatting edits, or generated copies (`linguist-generated` in the base revision's `.gitattributes`) | no verdict |
| `self` | at most 100 changed lines in at most 5 behavior files, no risk path, no lockfile or binary | the author's own `--self` verdict (or an independent one) |
| `focused` | more than 100 lines, more than 5 behavior files, or a lockfile or binary change | an accepted non-author verdict |
| `full` | 500+ lines, any file on a risk path, or a high-risk judgment | an accepted non-author verdict (a high-risk judgment still asks a `live` one at task close) |

Lines count code, tests and agent instructions (`SKILL.md`, `AGENTS.md`,
`CLAUDE.md`, `skills/`, `agents/`, `commands/`, `rules/`, `prompts/`);
lockfiles count as a behavior change but never toward size. A diff Workit
cannot read reads as `focused`. The lane gates `workit pr merge`, `workit
stack land`, the Stop hook and the task's `verdict:lane` requirement alike.

The lane fails closed: when Workit is unsure a file is docs, a comment or
formatting, it counts as a behavior change.

- **Docs** are told by extension only: code under `docs/` or in a
  `generated/` folder is code.
- **Comments and formatting** are told by reading each whole file on both
  sides with its strings, template literals and block comments, for
  TypeScript and JavaScript (not JSX), Java, Kotlin, Scala, Swift, Dart,
  Groovy, Go, CSS, SCSS, LESS, Python, TOML and markup without scripts.
  Directive comments (`@ts-ignore`, `eslint-disable`, `noqa`, `//go:build`
  and the like), shebangs and whitespace inside strings are code. A file
  with a lone carriage return, U+2028 or U+2029 (CRLF is fine) is read like
  a binary: never cosmetic, so the lane is at least `focused`.
- **Documented limits.** The C family (C, C++, Objective-C, C#), Rust, SQL,
  shell, Ruby, YAML and every other type without a lexer keep their
  comments: only trailing whitespace is cosmetic there. Where a lexer
  exists, a few constructs are read as behavior rather than guessed at:
  Python f-strings with a nested string inside `{}`, an unquoted CSS
  `url(`, and a JavaScript `/` after `)` with another `/` later on the line.
- **Generated copies** come only from the `.gitattributes` files of the base
  revision (the fork point), never `.git/info/attributes`, a global
  attributes file or the change itself.
- **Risk paths** are decided first and override every other kind: a
  comment-only, generated, docs or lockfile change on a risk path is still
  `full`. Built in: a path part such as `auth`, `security`, `secret`, `gate`,
  `policy`, `hooks`, `release`, `migrations` or `.github/workflows` (never a
  test or a doc), CI files, every `.gitattributes`, and `.workit/risk-paths`.

#### Repo risk paths: `.workit/risk-paths`

A repository adds its own risk paths in `.workit/risk-paths`: one glob per
line (`**` spans directories, `*` and `?` stay within one, a bare directory
covers everything under it), `#` comments and blank lines skipped. Workit
reads it from the base revision only, so a change cannot remove an entry
to lower its own lane; entries only tighten. A change to the file is itself
a risk path, and it protects the next change, not the one that adds it.
Workit's marker directory ignores everything else in `.workit/` but leaves
`risk-paths` visible (`.workit/.gitignore` is `*` and `!risk-paths`; `workit
doctor --fix` and any command that creates the directory rewrite the old
`*` alone), so `git add .workit/risk-paths` is enough. While the file is
untracked, `policy assess` and `pr status` warn that it does not apply until
it is committed on the base.

```text
# merge gates and what they read
src/billing/**
packages/core/src/gates/merge.ts
```
A current independent failed verdict or a tampered ledger still blocks every
lane. `verification: "self"` and `"independent"` keep their earlier rules,
including a non-author verdict to merge.

Spend verifiers by lane: none for `none` and `self`; one per PR after its
last push for `focused` (a cheaper model where the host lets the lead pick
one, e.g. Claude Code `model: sonnet` on the Agent call) and `full` (the
strong model).

### Carry-over and stack verdicts

A verdict is keyed to the head it judged. It still applies to a newer head
(`carried`) when:

- **Rebase:** the change against the base has the same patch-id and the same
  exact diff, or `workit stack sync` observed a patch-equal restack, and
  every file the branch changes is byte-identical at both heads while the
  base left it alone.
- **Lane-none follow-up:** the branch's own change since the judged head is
  lane `none`: docs, comment or formatting edits, generated copies, or an
  empty commit (a CI retrigger). Base changes from a rebase are left out.
- **Test-only follow-up, `unit` verdicts only:** every changed file is a test
  (under `test/`, `tests/` or `__tests__/`, or named `*.test.*`, `*.spec.*` or
  `*_test.*`; a `fixtures/` or `spec/` folder is not) or docs, off risk paths,
  with no lockfile or binary, and the change is small (lane `self`: at most
  100 lines in at most 5 files). A `live`, `review` or `perf` verdict does not
  carry over test changes.

Anything else makes the verdict stale. That includes any behavior change, a
risk path (even a comment there), a lockfile or binary, a lint or formatter
config change, or a diff Workit cannot read. A hand-appended or untrusted
verdict row never carries. When the branch was rebased between the two
heads, files are compared by exact content, not by diff text: a file whose
result differs, or that the base also changed, counts (so an edit moved
within a file, or a rebase onto a base that touched a branch file, needs a
new verdict), and none of them counts as a comment or formatting edit. A
carried independent failure still blocks.

`workit ledger check` and `workit pr status` show the reason, for example
`carried (lane none since 1a2b3c4d5e6f)`. In `--json`, the verdict's `carry`
holds `rule` (`lane-none` or `tests-only`), `since` and `files`. When the
newest passing verdict is stale only because of a small change off risk
paths (that change's lane is `self`), `pr status` prints
`reverify: focused (<files>)` (`verdict.reverify` in JSON). The verifier then
re-checks only those files since the judged head and reuses green CI on the
head, with no fresh install and no full suite.

**Stack verdicts.** One verifier at the top of a stack, after its last push,
can cover the lower PRs. A lower branch with no accepted verdict of its own
is accepted by a verdict on a branch above it in the stack when all of these
hold:

- the upper verdict is accepted for that branch now;
- its session is not an author of the lower branch;
- every commit of the lower branch since the trunk has a verbatim patch-id
  (whitespace counts) among the commits of the judged head (not merge
  commits, and at least one commit);
- the judged head holds exactly the lower branch's files: no upper commit
  reverted or rewrote a file the lower branch changed;
- the lower branch's own lane is not `full` (no risk path, not a large diff).

If the lower branch gained a commit or was amended after the verdict, or
Workit cannot read any of this, it is not covered and needs its own. `workit pr merge`, `workit stack land`,
`workit stack status`, `workit pr status` and `workit ledger check` name the
covering verdict (`cover` in JSON). The Stop hook still reads each branch's
own verdicts.

Every `policy assess` is recorded in the ledger as a `policy.judged` row
(session, what was sent, the resulting requirements). A session that judged
an open product choice or a needed plan cannot lift it silently: its own
`product-choice=no` or `plan=no` needs `--why "<reason>"`, which the row keeps.

Trivial work judged `risk=trivial behavior=no` needs nothing at task close
(its PR still merges by its lane). Task close trusts the recorded judgment;
the merge gate reads the diff lane. A `risk=trivial` task that still changes
code needs what its lane asks before merge. A `behavior=no` judgment at normal risk
still owes what the lane asks, except outside git, where no branch can hold a
verdict. Before-write
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
token's sha256. The context carries the whole verdict command, filled in:
`workit ledger verdict <verified|failed|blocked> --kind <live|unit> --branch <b> --session <lead>:<agent id> --token=<token> --how "…"`
(`--kind review` for a reviewer; the branch is the checkout's, or `<branch>`
on a protected branch or a detached HEAD). A SubagentStart fired again for an
id already issued prints no command: spawn a fresh verifier instead. An OpenCode child gets the same line without `--session` and
`--token`, since its shell already acts as `<lead>:<child>`. `ledger verdict`
accepts the id only with `--token=<token>`
(or `WORKIT_SESSION_TOKEN`), so a lead or sibling that read the id in the
ledger cannot record under it (`unbound_session`), nor supersede that
reviewer's failure. The row then carries `sessionBound: true`. Each id is
issued once: a SubagentStart fired again for an id already issued mints no
new token. The token hash lives in its own tree (`<state>/issued-tokens/`),
which hooks older than tokens never write, and binding is sticky: once a lead
has any token-bound id, a token-less record under it (an old cached plugin
hook rewriting one, or issuing a new id) is refused as `unbound_session`. Only
a lead that never had a token keeps the old path, where an id an older hook
issued (`workit-issued-sessions/2`) is accepted without one; `workit doctor`
reports that plugin as out of date. The token needs a CLI at least as new as
the plugin: the SubagentStart text says to update an older CLI that rejects
`--token`.

On a host, `--session` takes only an issued id. Naming a declared shell
session (`--session <lead>` on Claude Code) is refused as `session_flag`:
drop `--session`, the shell's own session already acts. Naming a session the
shell derives itself (an OpenCode child's `<lead>:<child>`, a Pi worker's id,
a Codex thread id) is accepted as a no-op. Every
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
  dir. A caller that writes there deliberately can mark any id as issued or
  plant a token hash it chose. The token itself sits in the subagent's
  transcript, which a caller that reads the host's transcript files can find.
- Claude Code, Codex: anyone who can run the hook bundle can mint a new id
  and its token (a SubagentStart with an agent id never used), and record an
  independent verdict under it. Issue-once only stops re-minting an id that
  already exists.

Verdicts are SHA-keyed and carry over a rebase when
the patch-id and diff are unchanged, and over a docs-only (or, for a `unit`
verdict, small test-only) follow-up ([carry-over](#carry-over-and-stack-verdicts)). A dirty tree is refused, also when the
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
whole ledger aside. Moving the ledger aside (the documented repair) also
drops every independent failure in it: re-record those before merging.

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
- **Short ids.** `workit finding resolve` (`findingId`), `workit worker
  cancel|report` (`workerId`) and the finding ids inside a worker report accept
  a full UUID or an unambiguous prefix of 8 or more characters, the short id
  the ledger and verdict reports print. An ambiguous prefix fails with
  `invalid_input` and lists the candidate ids; an unknown one is `not_found`.
- **Bounded summary.** `workit task inspect --view summary` (the default view)
  prints a task brief that stays under 4 KB however long the history is: the
  objective, status, progress, closure, and the requirements still owed, with
  long text truncated and `truncated: true` when anything was cut. Use
  `--view full` for the whole record (it can reach megabytes). An OpenCode
  child session without a worker can call `workit_task` `inspect` and always
  gets this brief; every other task action from it is still refused. On the
  MCP hosts (Codex, Cursor) an unattested caller, and on Pi a worker, gets the
  same brief from `workit_task` `inspect` with `view: "summary"` or no view;
  attested leads keep the full engine summary.

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
