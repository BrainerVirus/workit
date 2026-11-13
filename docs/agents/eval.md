# Weak-model bench

Workit has to work on weak models and after a model switch. The bench measures
that on real models, locally, against cases taken from real agent failures.
It never runs in CI: it needs a Claude or OpenCode login and spends
subscription usage (ledger decision mw6gvdys). It has two legs, Claude Code
(the default) and [OpenCode](#opencode-leg); Codex, Cursor and Pi are skipped
here, and the replay and hook tests cover their parity. The deterministic replay of hook and CLI output is
layer 0 in [testing.md](testing.md#agent-behaviour-eval).

## Run it

```bash
bun scripts/eval/run.ts --model haiku --tier smoke            # the smoke cases, up to 3 model runs
bun scripts/eval/run.ts --model claude-haiku-4-5 --tier full --budget-runs 12
bun scripts/eval/run.ts --model haiku --cases spawn-implementer --force
bun scripts/eval/run.ts --model claude-haiku-5-5 --tier full --cases stop-hold --repeat 3
bun scripts/eval/run.ts --host opencode --model deepseek-v4.1-flash --tier smoke
bun scripts/eval/run.ts --replay [--model haiku] [--check]    # re-grade stored transcripts, no model
```

- `--model` takes any Claude Code model alias or id. Results go to
  `evals/results/<model>/`, so `haiku` and `claude-haiku-4-5` are kept apart.
- `--budget-runs n` (default 3) caps how many `claude -p` runs one invocation
  starts. Cases past the cap are listed as `incomplete`; run again to continue,
  cached cases cost nothing.
- `--repeat n` (default 1) runs each case n times in fresh worlds. Run 1 is
  stored as `<case>.json`, run k as `<case>.run<k>.json` (each with its
  transcript); a case passes when at least two thirds of its runs pass (2 of
  3). Each run counts against `--budget-runs`, and its `summary.json` row
  lists every run under `runs`.
- A result is reused when its key matches: the case file, the model and the
  Workit version (`<last release tag>+<hash of packages/workit-core,
  packages/workit-cli/src and packages/workit-claude-code on disk>`). An edit to
  a skill, hook or CLI text re-runs every case; `--force` re-runs anyway.
- Exit 1 when a graded case fails, else 0. Commit `evals/results/` with the
  change it measures.

Tiers: `smoke` (a few cases, Haiku) for each slice that changes what agents
see (skills, hooks, verb output); `full` (every case) on Haiku 4.5 and Haiku
5.5 before a release, where the gate is no drop against the committed
baseline. Sonnet and Opus are optional. A smoke run on Haiku costs cents of
subscription-equivalent usage; the printed `$` is Claude Code's
`total_cost_usd`.

## OpenCode leg

`--host opencode --model <m>` runs the same cases through `opencode run`
(OpenCode 2.x) with the same grader. Each case first runs on the free provider
(`opencode/<m>-free`). When it stops on a rate or quota limit (`provider.free-limit`,
`provider.quota`, HTTP 429), the case is run again in a fresh world on the
paid go provider (`opencode-go/<m>`), and so are the cases after it. The result
records `provider: free` or `go`, plus the limits seen. When both are limited,
the case is recorded `skipped: "limit"`, never as a pass: it is not graded, it
is never a cache hit, `--replay` leaves it alone, `summary.json` counts it under
`skipped`, and the run exits 1. Any other provider error (an expired key, say)
fails the case with `run-error`.

Results go to `evals/results/opencode-<m>/`, apart from the Claude Code
results. The Workit version hashes `packages/workit-opencode` instead of
`packages/workit-claude-code`. Before the first run the runner builds the
plugin (`packages/workit-opencode/scripts/build.ts`), and every case pins it:

```bash
opencode run --standalone --format json --auto --archived --model <provider>/<m>   # prompt on stdin
```

The world gets its own `XDG_CONFIG_HOME/opencode/opencode.json`. It holds the
`file://` plugin pin, `agents.build.steps` from `maxTurns`, and `permissions`
(deny everything, then allow the Workit tools and the case's tools, mapped from
the Claude names: `Bash(x *)` becomes `shell` on `x *`, `Agent` becomes
`subagent`). Your OpenCode login stays (OpenCode's data dir). Your config,
plugins, MCP servers, Claude Code skills and `OPENCODE_*` variables do not.
`PWD` is the world repo, and `WORKIT_INSTALL_ROOT` points inside the world, so
`workit` is this checkout's CLI and not an installed one. Sessions are created
archived in your OpenCode database. `permissionMode` does not apply.

The model gets the same closed `<workit-contract>` block on both hosts
(maintainer decision on #793), so a case such as `session-context` asks the
same question of each and never takes a per-host answer.

## What a run does

Each case gets a throwaway world under the OS temp dir: a git repo on the
case's branch with its files, uncommitted changes, `.workit/checks.json`, an
optional bare `origin` and an optional second worktree, plus its own
`WORKIT_STATE_DIR`, `WORKIT_CONFIG_DIR` (branch policy: `feature/*`
allowed, `main` protected) and `HOME` ([isolation](#isolation-and-the-tripwire)).
Then, in the repo:

```bash
claude -p --model <m> --output-format stream-json --verbose --max-turns <n> \
  --setting-sources "" --strict-mcp-config --no-session-persistence \
  --plugin-dir <checkout>/packages/workit-claude-code \
  --permission-mode <dontAsk|case> --allowedTools <case tools> \
  --disallowedTools WebFetch WebSearch          # prompt on stdin
```

The child keeps your Claude login and drops `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and every `WORKIT_*` variable, so a run is billed to the
subscription and never writes to the calling session's ledger. The plugin's
`bin/` leads `PATH`, so `workit` is this checkout's CLI. When
`packages/workit-claude-code/skills/` is missing the runner builds it
(`build.ts --skills-only`). Default tools: Read, Edit, Write, Glob, Grep,
Skill, Agent and Bash limited to `workit`, `git` and read-only `cd`, `ls`, `cat`,
`head`, `tail`, `grep`, `wc`, `diff`, `echo` and `pwd`. Claude Code asks before
any `cd` chain with git, and dontAsk would deny it, so the bench's own
PreToolUse hook (`--settings`) allows `cd <dir> && <read-only>…` (git `status`,
`log`, `diff`, `show`, `rev-parse`, `branch --show-current`, or the read-only
commands above), as a real host would; anything else (a whole
chain, when one part is not allowed) is denied, and the denial shows in the
transcript.

### What a committed result holds

`evals/results/` is public, so before the runner writes a transcript or a
result file (`scripts/eval/privacy.ts`):

- **Placeholders.** The world path (and Claude's project slug of it) becomes
  `<world>`, the checkout `<workit>`, the account's home in every absolute
  spelling (the OS record's, the runtime's, resolved) `~` (`<home>` as a
  project slug), the login name `<user>` and the host name `<host>`. The
  dirs the bench itself puts a host in become placeholders too: a checkout or
  store this checkout's `node_modules` link into is `<linked>` (a linked
  worktree's packages are symlinks into the main checkout), and a
  toolchain's install dir the read rules allow under your home is
  `<toolchain:bun>`, `<toolchain:node>`, `<toolchain:git>` or
  `<toolchain:<host binary>>`, each in every spelling (its path, and that path
  under `~`, `$HOME` and `${HOME}`). Such a path is the bench's own doing: it
  can spell one of your host's project paths or a workspace's name without
  holding either. Three rules keep a placeholder from hiding anything of
  yours. A root is replaced only where it stands as a whole path: not before
  and not after a character a path segment goes on with (a letter, a digit,
  `_`, `.`, `@`, `+`, `~`, `-`), so `<root>/x` and `"<root>"` are the root and
  `<root>-client`, `<root>x` and `/mnt<root>` stay as written. A root glued
  to a one-letter option at the start of a word (`-C<root>/x`, `-I<root>`,
  `"-C<root>"`, after a space, a quote, `=` or `(`) is the root too, and so
  is `--dir=<root>`; `a-C<root>` and `<root>secret` stay as written. The home
  becomes `~` by the same rule, and the committed-results scan flags a home
  path glued to an option as well. The refusal
  looks at the text before the roots become placeholders and lets through
  only a string that lies wholly inside a root named that way (the root
  itself, a part of it): a private value that starts with a root, contains
  one or sits beside one is still refused. And a root is never your home, a
  dir above it or a dir that holds a guarded path: such a store gets no
  placeholder. The checkout's `<workit>` follows the first two rules as well:
  it goes in as a whole path only, and the refusal puts it back to look, so a
  private value under the checkout or beside it is still refused. A call that
  names a root's path is outside the world.
- **Scrub.** The scrub does not decide what a call read: nothing that reads a
  command's text can (a glob, a quote, a script the model wrote, a path an
  interpreter builds). The kernel does, so there are two regimes:
  - _Reads confined_ (`read confinement: on`): a call could read only the
    world and the read rules below, whatever its command spells. A result
    stays unless the call names a path outside the world (Claude Code's Read,
    Grep, Glob, Edit, Write, Bash; OpenCode's read, grep, glob, list, shell).
    Every named path is resolved first: a relative one against the call's
    working directory (the world's project dir, unless the call's `workdir` or
    an earlier `cd` in the same script says otherwise); `$HOME` and the
    `XDG_*_HOME` bases expand as `~`, which counts as outside. A `..`, an
    unknown variable, a command substitution or a relative path after a `cd`
    it cannot follow is `unresolved` (or the class its tail names, such as
    `.config/workit`), never inside. Paths under `<world>` and `<workit>` and
    `/dev` streams stay.
  - _Reads not confined_ (no Landlock, or `read confinement: off`): no result
    of a call that ran is stored, for any tool.

  A removed result becomes `<outside-world file: <class>, <n> bytes>`, the
  class being `real config`, `real state`, `host config`, `home`,
  `unresolved`, `system` or `unbounded` (nothing confined the read and the
  call names no outside path). Inputs always stay.
- **A refused call.** A call that never ran read nothing, so its result is the
  hook's or the host's words. The scrub keeps them only on the evidence the
  grader uses to call the call `denied` (`Refusal` in `scripts/eval/grade.ts`,
  one function for both), never on how a result is worded:
  - Claude Code's `permission_denied` event naming the call (a hook's deny or
    ask, or the permission mode; with nobody to answer, an ask is a deny):
    the host's own flag, so the whole result stays.
  - Claude Code's blocking hook (exit 2) leaves no event, only a failed
    result that opens `PreToolUse:<the call's tool> hook error`. Those words
    stay; what follows them is removed like any result, with its `facts`.
  - OpenCode's deny is the whole error `Permission denied: <permission>`,
    naming the call's tool or a permission OpenCode has. It stays; any other
    error is removed.

  A command that prints those words, a command that exits non-zero, and a
  host sentence such as `Claude requested permissions…` are results like any
  other.
- **Only events are stored.** A line of the host's output that is not a JSON
  event is dropped; a closing `{"type":"scrub","removed":{…}}` event says how
  many lines and bytes went.
- **A removed result never changes a grade.** Before the text goes, the scrub
  stores beside the marker the grader's own answers about it (`facts`: each
  `result` pattern of the case, and for a spawn the refusal test, to whether
  the real text matched), and the grader answers from them. The stored
  transcript is the one graded, so `--replay` agrees with the live grade. A
  `result` pattern added or changed after the run has no stored answer: it
  counts against the run (a `forbid` or `atMost` rule matches, a `require`
  rule does not), so re-run the case. A failure's detail quotes the marker,
  never the removed text.
- **Refusal.** At bench start the runner builds, in memory only, the real
  account's private strings: every string of 6+ characters in its Workit
  `workspaces.json` and `config.json` (Workit's own vocabulary aside: the
  core schemas' words, model names, default branches and prefix patterns),
  the paths of its `~/.claude.json` projects map (absolute and `~`), every
  git `user.name` and `user.email` in its global git files and what they
  include, and its home. A run whose transcript or result still holds one,
  or an absolute home path or a projects map, fails as `private_content`
  naming the file and the kind of string, never the string; nothing of that
  run is written. The set is never written or logged. One of those files that
  exists but cannot be read or parsed stops the bench before any run (exit 4,
  `private set: cannot read <file>: <reason>`, never its content); a missing
  one is fine.
- **Host credentials.** The refusal also knows every credential the bench
  host could reach, under the kind `host credential`: each string value of 20+
  characters in the host's login (Claude Code's `~/.claude/.credentials.json`;
  OpenCode's `opencode.db` `credential` rows and `auth.json`), and the value
  of every variable in the host's environment whose name says key, token,
  secret, password or credentials. The floor is 20 because every token and
  key in use is longer, while the plan names, scopes and provider ids beside
  them are mostly shorter; a longer non-secret in a login file reaches a
  transcript only when the file was printed. The login is read at bench
  start, before each run, in each world before it is removed (a token rotated
  by rename, a key OpenCode wrote into its world) and again when the result
  is written, so a credential refreshed mid-run is refused under its old and
  its new value. A login file that exists but cannot be read stops the bench
  at start (exit 4) and fails a run whose result it would have checked.
  A call that names the world's own login (`<world>/home/.claude`,
  `<world>/home/.claude.json`, `<world>/home/.local/share/opencode`) is
  scrubbed as `host config`.
- **Account ids.** The world's sign-in state names the account, so the
  refusal knows it too, under the kind `account id`, read at the same four
  points from the real home and from each world: for Claude Code the keys a
  world's copy of `~/.claude.json` keeps (the user id) and everything under
  `oauthAccount` (the account and organisation ids; the e-mail address, which
  the copy drops and the host may fetch back); for OpenCode the other columns
  of its `credential` rows. A value counts when it is an e-mail address, has
  32+ characters, or has 20+ under a key that says id. The floor is 32
  because a UUID is 36 and the user id 64, while the plan, tier, role and
  version words beside them stop at about 22, so no ordinary word is refused.
- **Committed check.** `test/behavior/eval-privacy.test.ts` fails when any file
  under `evals/results/` holds an absolute path under a home dir (`/home/…`
  or `/Users/…`; the placeholders and the invented names `me`, `user` and
  `example` aside), a host config's `projects` map, or a workspace glob under
  the real home.
- **Diagnosing a refusal.** A `private_content` refusal prints, on the
  terminal only (it is in no file, and nothing of the run is written), where
  each hit is, without the value:

  ```
  where (shown here only, in no file; no value is shown; an id is salted per bench start: equal ids are one value):
    <case>.transcript.jsonl: event 9, user result of Bash call (14 chars; starts with workit): host project path, 41 chars, id 3f9a1c2e, from ~/.claude.json: projects, key 3 of 9 (as a ~ path)
    <case>.transcript.jsonl: event 12, assistant (the model's text): real Workit config value, 12 chars, id 0b7d44a1, from ~/.config/workit/workspaces.json: workspaces[0].name
  ```

  A line names the file, the event (its 1-based line in the transcript; a key
  path in the result file), the event's type and the field (a tool's input, a
  call's result, the model's text, the answer text, or a key path), the kind,
  the value's length, an id (the first 8 hex of a sha256 salted per bench
  start: two hits with one id are one value, and an id means nothing in
  another bench start) and where the runner read the value from.

  A line holds structure only, never text a model or you wrote: no excerpt of
  a command, a path or a result. A call is named by its tool, and a shell call
  by its command's length and its first word when that word is on a fixed
  list of commands (`workit`, `git`, `ls`, `cat` and the like; otherwise `a
  command not on the list`). An event type, a tool and a key are named only
  when they are on the fixed lists of the two transcript formats and the
  result file (`scripts/eval/privacy.ts`); anything else is `an event`, `a
  tool` or the key's position, `{key 2}`. An origin names only well-known
  files (`~/.config/workit/workspaces.json`, `~/.claude.json`,
  `~/.gitconfig`, the hosts' login files) with the key path, the `projects`
  key's position, the git key or the database row and column; a file in a
  place you chose is named by its class (`the Workit config dir's
  workspaces.json`, `a git config file included from ~/.gitconfig, include
  1`), a key you chose by its position, and an environment secret as `a
  variable named as a secret`. A shape
  the committed check refuses (a home path, a projects map) has a place and a
  kind only. Read it as: the same id in a tool's result and then in the
  model's text is one value the model repeated; a path-length value whose
  origin is a `projects` key, sitting in an error message, is a path the
  bench itself produced, which belongs in the placeholders above.
- **Known false refusal.** A private config value that is an ordinary word
  (it also appears in public text such as the README) makes a run that quotes
  that text fail as `private_content`. That is the safe direction; the
  diagnosis shows it as a `real Workit config value` of a word's length whose
  origin is a name or label key. Rerun the case.

## Isolation and the tripwire

A bench run must never change your real Workit files (#822: a run rewrote
`~/.config/workit/workspaces.json` through a `python3` heredoc).

- **World HOME.** `HOME` and the four `XDG_*_HOME` bases point inside the
  world, so `~`, `$HOME` and every Workit path derived from them (config,
  state, `approvals/`, the issued registry) resolve there. The host
  gets only its login, into real world dirs (so `cd -P ~/.claude/..` stays in
  the world): Claude Code's `~/.claude/.credentials.json` is symlinked (it
  refreshes in place; a host that replaces the link by rename has the new
  bytes written back to the real file, and the runner prints that) and
  `~/.claude.json` is copied with only its sign-in keys (onboarding state,
  user id, account and organization ids and tiers; no e-mail, names,
  projects map, history, MCP servers or caches); OpenCode gets a fresh `opencode.db` with the
  real one's schema and only its `credential`, `kv` and migration rows. No
  settings, `CLAUDE.md`, skills, hooks, plugins, sessions or caches.
- **Grants dir.** Workit reads the account home from the OS record on every
  runtime, never `$HOME` (D15, `packages/workit-core/src/core/account-home.ts`),
  so the world `HOME` does not move grants. Every world is marked and named by
  `WORKIT_EVAL_WORLD`, so inside it `workit grant show` and `grant set` use the
  world's `config/` dir. What applies is the account's real entry when one
  matches the world, else the world's entry lowered below the D4 defaults:
  the world can only lower grants. The account's `workspaces.json` is read,
  never written.
- **Self-check.** Before a case whose prompt names a shell wrapper (`bash`,
  `sh`, `python3`, `node`, `bun`, `eval`, ...), or whose allow list or
  permission mode lets one run, the runner resolves every guarded path in a
  child with the run's env (`run.ts --isolation-probe`: the real resolvers,
  then `workit dir config|state`, `workit grant show --all`, `workit grant
  show`, `workit workspace list`). `grant show --all` prints the file grants
  are listed from and `grant set` writes; `grant show` must be a Workit answer
  with no forge account, for no workspace or for this world's entry (its
  `world` field, which only a bench world entry sets). A path outside the
  world, a verb that prints no path, or a `grant show` that names a real
  workspace or account refuses the case: the host never starts and the run
  fails as `isolation`.
- **Tripwire.** The tripwire only detects. It never writes, removes or renames anything in your home. On a change this bench could have made it kills the host, fails the run as `outside_write`, stops the bench with exit 3, and prints for each path what was there, what is there now, where the original copy is, and for the simple cases the command to put it back.
  - A change another process made is reported and stops nothing. That is decided from the run itself: Landlock write confinement was applied to it (the bench start printed `write confinement: on`, the case was not refused, the launcher did not exit 126), the change is one Landlock's rights govern (a guarded path's content, kind or presence changed; its mode and link count did not), and the path is not one the run's ruleset made writable. The kernel refused this bench that write, so another process made it: a second session recording a verdict, you editing your config. The runner prints `outside change, not this bench's: write confinement was on, so this change was made by another process; …` with what changed and, for a watched file, where its copy from the bench start is (in the journal, until this bench ends). The host is not killed, the run's result is written as usual and records the change (`outsideChanges`: each path under `~` with `created`, `changed` or `removed`, no content; `summary.json` counts them per case and in total), the change becomes the state later checks compare with, the journal is dropped at the end as for a clean run, and the summary line counts them (`; 1 outside change(s) by another process, reported above`). The exit code does not change.
  - When the runner throws during a run (after the host ended, removing its world fails, say), the guarded files are checked at once with the bench's own confinement, and the result is reported before the error goes on: another process's change is printed as above (`…; the run threw, so no result records it; this change stops nothing`), taken as the new state and counted; any other change prints `STOPPED: <case> changed real Workit files outside its world, then the runner failed (its error follows)` with each finding and its commands, and keeps the journal. No result is written for that run, and the error leaves the runner as before.
  - One more check runs after the last run and before the journal is dropped. A change it finds is handled by the same rule with the bench's own confinement: another process's change is reported (no result records it: no run was under way); anything else prints `STOPPED: real Workit files changed after the last run's check`, keeps the journal and exits 3.
  - Everything else stops as before: any change without write confinement (no Landlock, `--confine off`, a refused case, a launcher that could not apply the rules); and with it, a mode change, a link count change, a replaced root, an unreachable path, a file over 64 MB, or a change to a guarded path the ruleset made writable.
  - Watched: the config dir, whole (tokens, `vcs.json`, `templates/`, backups included), and the state files that grant or pick what runs (`host-permissions.json`, `host-permissions-backup/`, `node.json`). At bench start, after taking the lock, the runner snapshots them into its own memory and re-checks them after each run and every 2 s while a host runs.
  - Reported the same way: the state trees `approvals/`, `issued/`, `issued-tokens/` and `verdicts/`, which live sessions also change.
  - Not watched: `leases/`, `logs/`, `hook-runs/`, `live-sessions/`, `worktrees/` and the other caches every session rewrites.
  - Reading is as careful as writing is absent: a root whose kind, link target or device and inode changed is reported as `root replaced` and not walked; below a root nothing is followed; a file is read only when it opens with `O_NOFOLLOW|O_NONBLOCK` as a regular file; files over 64 MB are compared by size; a created dir is reported, not entered; at most 50 created paths are listed per root.
  - Commands are printed only for simple cases: a changed or deleted regular file with one link and an unchanged parent chain gets `diff -u` and `rm -f -- … && cp -- <original> … && chmod …`; a mode change gets `chmod`; a created file, symlink or FIFO gets `rm --`; anything else gets `ls -la` and the original's path.
  - `--replay` never re-grades an `outside_write` run.
- **Digest and journal.** At arm the runner prints `tripwire armed: <N> files, digest <16 hex>` and writes the journal, your recovery copy, to `~/.cache/workit-bench-tripwire/journal/` (0700, files 0600), removed at a clean end (a bench that only reported another process's changes ends clean). A changed file stays changed until you act. After a stop the bench will not start while a leftover differs; it drops the leftover once nothing differs, or on `--tripwire-discard`. A start that finds a leftover writes nothing and prints `LEFTOVER` in the same format; it prints no command for a journal it cannot trust (unreadable, a path outside the watched roots, a blob that does not match), and the journal's digest proves nothing unless it equals the line the stopped run printed.
- **Stopping and other runs.** Ctrl-C, SIGTERM or SIGHUP kill the host's process group; the run unwinds (its world removed, the real files checked against memory), prints `STOPPED by <signal>`, writes no result for that run and exits 130, 143 or 129; the journal stays only when something changed that this bench could have made (another process's change under write confinement is reported and leaves none). One bench holds the tripwire at a time (`holders/<pid>.<start>`); a second one exits 4. Every dir the tripwire uses under `~/.cache/workit-bench-tripwire/` (the base, `holders/`, `journal/`, `blobs/`) must be a real directory you own; a symlink, a file or another owner's dir stops the start with exit 4 and nothing is created or removed there. It removes only by unlinking, so a link planted in its dir loses only itself, and in `holders/` it unlinks only regular files named `<pid>.<start>` of dead runners. Each start removes the `workit-eval-*` worlds a dead runner left in the temp dir. The start-time sweep also removes a directory named `workit-eval-*` under the temp dir that has no `.runner` marker and is older than 24 h, even if the runner did not make it. The sweep skips symlinks and dirs you do not own, reads a `.runner` marker only when it is a regular file, never follows a link inside a world, and reports a world it cannot remove without stopping the start.
- **Write confinement.** On Linux the host runs under Landlock: it and everything it starts can write only in its world, the temp dirs, `/dev` and the host's own credential file. A write, delete, rename, link or create anywhere else in your home fails in the kernel. The runner itself stays unconfined. `scripts/eval/confine.ts` applies the rules through `bun:ffi` (glibc's `syscall`, x86_64 or arm64, Landlock ABI 3+); any failure exits 126 without running the host. A temp dir that holds your home, a guarded root or the tripwire dir is not made writable, since Landlock has no deny rules. Each bench start checks it with a canary write into the tripwire dir and prints `write confinement: on (Landlock ABI n)` or `off (<reason>)`.
- **Read confinement.** Under the same Landlock ruleset the host can read, list and execute only its world and the temp dirs, `/dev`, the system dirs (`/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/opt`, `/proc`, `/sys`, `/run`, `/snap`, `/nix`, `/var/lib`, `/var/cache`), this Workit checkout, the packages its `node_modules` links to and the `node_modules` store they sit in (a worktree links them into the main checkout's `node_modules`: that store is readable, the main checkout's source and other files are not; the host's environment sets `NODE_PRESERVE_SYMLINKS=1`, so a linked package stays at the path this checkout names it by and its imports resolve through this checkout's `node_modules` instead of the main checkout, whose listing bun would need and may not have, and `NODE_PATH` names the store for a dependency this checkout does not link; a linked package then finds its own dependencies as in a plain checkout, and no path of the main checkout reaches an error message), the install dirs of bun, node, git and the host binary (a `bin` dir's parent: `~/.bun`, the fnm node version, `~/.local/share/claude/versions`, `~/.opencode`), and its own credential file. Your real Workit config and state dirs, the host config dirs (`~/.claude` but the credential file, `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.config/opencode`, `~/.pi`, `~/.local/share/opencode`) and every other project or file in your home are not readable. A candidate dir that holds the home or a guarded path is dropped. Each bench start lists the real home under the run's rules and prints `read confinement: on`, or `off (<reason>)` when the listing works. Both hosts start signed in under it (one `session-context` run each).
  Without Landlock (another OS, a kernel before 6.2) a case that permits a shell wrapper is refused unless you pass `--unconfined`; it then runs with detection only.
- **Open and limits.**
  - Landlock does not cover metadata: a bench agent can `chmod`, `chown` or `touch` a real file. A mode change on a guarded file stops the bench as an outside write; nothing else is seen.
  - A bench agent can ask a service of yours that runs outside the sandbox to write for it (`systemd-run --user`, a tmux or docker socket). Such a write to a guarded file is seen within 2 s, but under write confinement the bench cannot tell it from any other process's write: it is reported as another process's change and stops nothing. Read that report line: a change you cannot place is yours to check. To any other file it is not seen.
  - The temp dirs and `/dev` stay writable, so files there (other tools' scratch files) are not protected.
  - A change to a watched file is seen within 2 s, the watch interval, and the host is killed unless the change is another process's (see Tripwire); the changed bytes stay until you act, so a live session that reads the file meanwhile sees them.
  - If the runner dies after another process's change and before its clean end, the journal still holds the bench start's copies, so the next start reports that change as a leftover and runs nothing until you settle it.
  - A bench agent can kill the runner, which ends detection. Under Landlock what it leaves running still cannot write your home. Everything the runner leaves on disk is writable and deletable by the same OS user, so the next start reports a leftover only if the agent left one and cannot prove it genuine; the digest the stopped run printed on your terminal is the only check, and it is yours to make.
  - A bench agent that attaches to the runner (ptrace, `/proc/<pid>/mem`) can change the snapshot in memory. With `kernel.yama.ptrace_scope` 1 or higher (Ubuntu's default) the kernel refuses a child attaching to its parent; with 0 nothing does.
  - The host's login (`~/.claude/.credentials.json`, the world's copy of `~/.claude.json`'s sign-in keys, the OpenCode provider keys) is readable by the bench agent by design: the host cannot sign in otherwise. A result that holds it is refused (see Host credentials above), in the form the login file stores it: a model that re-encodes a token (base64, split in two) or prints part of one gets past the refusal, and so does what OpenCode keeps in its `kv` rows.
  - Under Landlock the bench protects your real Workit files from change and your home from being read, except what the read rules list: the system dirs (`/etc/passwd` names your home; `/run` holds your runtime sockets), the temp dirs (other tools' scratch files), the toolchain install dirs (global packages and caches under `~/.bun`, for one) and the main checkout's `node_modules`. What a model reads there is scrubbed only when the call names the path (a spelling the scrub cannot read keeps its result); a model that quotes it in its answer is caught only by the refusal, which knows only the private strings above.
  - Without Landlock reads are unrestricted: a case that permits a shell wrapper is refused (or runs with `--unconfined`), and every case stores no tool result.
  - What the model writes itself is never removed, in either regime: its answer, its text between calls and every later call's input (a `Write` of what it read, a command that quotes it). The grader needs them. Only the refusal stands there, and it knows only the strings listed above (the Workit config's values, the host's project paths, the git identities, the home, the host's credentials and account ids). Without Landlock a model can read any file of yours and repeat it; with it, any file the read rules allow. A file outside that list which the model repeats is stored: read a transcript before you commit it, and do not commit one from a run without read confinement unread.
  - After the runner dies without its check (SIGKILL, power loss, a second Ctrl-C), a changed real file stays changed until you act; the next start reports it with the original's copy and runs nothing. The dead run's world, with its login copies in a 0700 dir, stays until that start.
  - The tripwire checks that each of its own dirs under `~/.cache/workit-bench-tripwire/` is a real directory you own, then lists it and unlinks by name. A process running as you that swaps one of those dirs for a symlink between the check and the unlink can redirect that unlink; a confined host cannot write there, an unconfined one (`--unconfined`) can. Open, not accepted: it needs a directory-handle walk that `node:fs` does not offer.
  - A process the agent moved out of the host's process group (`setsid`) outlives its run; what it writes later is caught by a later check in the same bench, and by nothing after the last one.
  - A signal is handled when the runner next reaches its event loop: a SIGTERM sent to the runner alone during a synchronous step (world setup, the self-check, up to 120 s) waits for that step. Ctrl-C at a terminal ends the step at once.

## Cases

`evals/cases/<id>.json`, one per real failure; `source` names it (retro item,
issue or `test/behavior/cases` file).

| Field | Meaning |
| --- | --- |
| `tier` | `smoke` or `full`; `--tier full` runs both |
| `prompt` | What the user typed; `{{root}}` and `{{worktree}}` become the scaffold paths |
| `scaffold` | `branch`, `files` (committed on main), `dirty` (uncommitted), `checks`, `worktree` (branch of a second worktree), `remote` |
| `maxTurns`, `permissionMode`, `allowedTools` | Defaults 10, `dontAsk`, the list above |
| `scaffold.allowedBranches` | Branch policy patterns; default `feature/*` (a release case adds `release/*`) |
| `scaffold.home` | Files written under the world HOME (a host install the case needs, such as `.cursor/mcp.json`); a path that is absolute, has a `..` segment or is not below HOME refuses the world |
| `scaffold.workspace` | The world's workspace entry `eval` (`defaultEndpoint`, `autonomy`), so `workit grant show` and the Stop hook see it. Only its endpoint and the grants it lowers below the D4 defaults count, and only where no real workspace matches (`packages/workit-core/src/core/eval-world.ts`). A lowered grant is an explicit grant without a forge account, so it also drops the endpoint to `commit` |
| `expect.atMost` | `{tool?, pattern, max, why}`: at most `max` calls match |
| `expect.configuredCheck` | Some Bash call is `workit check <a configured name>` (ad-hoc `--name … --` does not count) |
| `expect.require`, `expect.forbid` | `{tool?, pattern, result?, denied?, why}`: a regex on the Bash command, or on the JSON input for other tools. `result` is a regex the call's result must match too (output, error or deny reason); `denied: true` keeps only calls refused before they ran, `false` only calls that ran ([grading](#grading)) |

The cases that graded the agent's own choices in the retired `claude plugin
eval` suite (`packages/workit-claude-code/evals/`) were ported here; the ones
that only checked hook or CLI text are layer 0 cases in `test/behavior/cases/`.
A case may also check the final answer: `expect.answer` (`{pattern, flags?,
why}`), and `scaffold.commits` (`{message, files}` in order) builds history.

Add a case when a retro or issue shows an agent failing; calibrate its
patterns on the first real run and re-grade with `--replay`.

## Grading

`scripts/eval/grade.ts` reads only tool calls and their results, so stored
transcripts re-grade with no model. It reads both transcript formats. An
OpenCode call is graded under the Claude name (`shell` is `Bash`, `subagent`
is `Agent`, `read`/`edit`/`write`/`glob`/`grep`/`skill` are capitalized), and a
call in another session counts as a subagent's. Every case fails on:

- `spawn-refused`: an Agent (or Task) call refused by a hook or permission.
- `raw-git-push`: a Bash `git push` (any segment of a chain); `workit git push`
  is fine.
- `repeated-failing-call`: the same tool and input failing a second time.
- `run-error` (OpenCode): the run stopped on a provider error.

plus its own `configuredCheck`, `require` and `forbid`. A rule's `result` and
`denied` tell a hook deny from a kernel stop: under Landlock a write the hook
missed fails with `Permission denied` or `EACCES` in its result, and
`{"pattern": "python3", "denied": false, "result": "Permission denied|EACCES"}`
in `forbid` fails that run. A call counts as denied when Claude Code records a
`permission_denied` event for it or a `PreToolUse:<tool> hook error` result;
its result is the deny reason, so `result` can name Workit's. OpenCode records
only `Permission denied: <action>`, from Workit's plugin or a host rule alike,
with no reason. A rule without `result` or `denied` matches the input alone.

Each failure names the
call (`#4 Agent(workit:implementer: add hello)`). Changing a rule bumps
`GRADER_VERSION`; `--replay --check` exits 1 when a stored grade would change,
`--replay` rewrites them.
