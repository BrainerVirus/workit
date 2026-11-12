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
  project slug), the login name `<user>` and the host name `<host>`.
- **Scrub.** A tool call that read or listed a path outside the world (Claude
  Code's Read, Grep, Glob, Edit, Write, Bash; OpenCode's read, grep, glob,
  list, shell) keeps its input, but its result becomes `<outside-world file:
  <class>, <n> bytes>`, the class being `real config`, `real state`, `host
  config`, `home`, `unresolved` or `system`. Every path is resolved first: a
  relative one against the call's working directory (the world's project dir,
  unless the call's `workdir` or an earlier `cd` in the same script says
  otherwise); `$HOME` and the `XDG_*_HOME` bases expand as `~`, which counts as
  outside. A `..`, an unknown variable, a command substitution or a relative
  path after a `cd` it cannot follow is `unresolved` (or the class its tail
  names, such as `.config/workit`), never inside. Paths under `<world>` and
  `<workit>` and `/dev` streams stay. A hook's or the
  host's denial stays: it holds no file content and the grader reads it. The
  stored, scrubbed transcript is the one graded, so `--replay` agrees.
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
- **Committed check.** `test/behavior/eval-privacy.test.ts` fails when any file
  under `evals/results/` holds an absolute path under a home dir (`/home/…`
  or `/Users/…`; the placeholders and the invented names `me`, `user` and
  `example` aside), a host config's `projects` map, or a workspace glob under
  the real home.
- **Known false refusal.** A private config value that is an ordinary word
  (it also appears in public text such as the README) makes a run that quotes
  that text fail as `private_content`. That is the safe direction; rerun the
  case.

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
- **Tripwire.** The tripwire only detects. It never writes, removes or renames anything in your home. On a change it kills the host, fails the run as `outside_write`, stops the bench with exit 3, and prints for each path what was there, what is there now, where the original copy is, and for the simple cases the command to put it back.
  - Watched: the config dir, whole (tokens, `vcs.json`, `templates/`, backups included), and the state files that grant or pick what runs (`host-permissions.json`, `host-permissions-backup/`, `node.json`). At bench start, after taking the lock, the runner snapshots them into its own memory and re-checks them after each run and every 2 s while a host runs.
  - Reported the same way: the state trees `approvals/`, `issued/`, `issued-tokens/` and `verdicts/`, which live sessions also change.
  - Not watched: `leases/`, `logs/`, `hook-runs/`, `live-sessions/`, `worktrees/` and the other caches every session rewrites.
  - Reading is as careful as writing is absent: a root whose kind, link target or device and inode changed is reported as `root replaced` and not walked; below a root nothing is followed; a file is read only when it opens with `O_NOFOLLOW|O_NONBLOCK` as a regular file; files over 64 MB are compared by size; a created dir is reported, not entered; at most 50 created paths are listed per root.
  - Commands are printed only for simple cases: a changed or deleted regular file with one link and an unchanged parent chain gets `diff -u` and `rm -f -- … && cp -- <original> … && chmod …`; a mode change gets `chmod`; a created file, symlink or FIFO gets `rm --`; anything else gets `ls -la` and the original's path.
  - `--replay` never re-grades an `outside_write` run.
- **Digest and journal.** At arm the runner prints `tripwire armed: <N> files, digest <16 hex>` and writes the journal, your recovery copy, to `~/.cache/workit-bench-tripwire/journal/` (0700, files 0600), removed at a clean end. A changed file stays changed until you act. The bench will not start while a leftover differs; it drops the leftover once nothing differs, or on `--tripwire-discard`. A start that finds a leftover writes nothing and prints `LEFTOVER` in the same format; it prints no command for a journal it cannot trust (unreadable, a path outside the watched roots, a blob that does not match), and the journal's digest proves nothing unless it equals the line the stopped run printed.
- **Stopping and other runs.** Ctrl-C, SIGTERM or SIGHUP kill the host's process group; the run unwinds (its world removed, the real files checked against memory), prints `STOPPED by <signal>`, writes no result for that run and exits 130, 143 or 129; the journal stays only when something changed. One bench holds the tripwire at a time (`holders/<pid>.<start>`); a second one exits 4. Every dir the tripwire uses under `~/.cache/workit-bench-tripwire/` (the base, `holders/`, `journal/`, `blobs/`) must be a real directory you own; a symlink, a file or another owner's dir stops the start with exit 4 and nothing is created or removed there. It removes only by unlinking, so a link planted in its dir loses only itself, and in `holders/` it unlinks only regular files named `<pid>.<start>` of dead runners. Each start removes the `workit-eval-*` worlds a dead runner left in the temp dir. The start-time sweep also removes a directory named `workit-eval-*` under the temp dir that has no `.runner` marker and is older than 24 h, even if the runner did not make it. The sweep skips symlinks and dirs you do not own, reads a `.runner` marker only when it is a regular file, never follows a link inside a world, and reports a world it cannot remove without stopping the start.
- **Write confinement.** On Linux the host runs under Landlock: it and everything it starts can write only in its world, the temp dirs, `/dev` and the host's own credential file. A write, delete, rename, link or create anywhere else in your home fails in the kernel. The runner itself stays unconfined. `scripts/eval/confine.ts` applies the rules through `bun:ffi` (glibc's `syscall`, x86_64 or arm64, Landlock ABI 3+); any failure exits 126 without running the host. A temp dir that holds your home, a guarded root or the tripwire dir is not made writable, since Landlock has no deny rules. Each bench start checks it with a canary write into the tripwire dir and prints `write confinement: on (Landlock ABI n)` or `off (<reason>)`.
- **Read confinement.** Under the same Landlock ruleset the host can read, list and execute only its world and the temp dirs, `/dev`, the system dirs (`/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/opt`, `/proc`, `/sys`, `/run`, `/snap`, `/nix`, `/var/lib`, `/var/cache`), this Workit checkout and the packages its `node_modules` links to (a worktree links them to the main checkout's), the install dirs of bun, node, git and the host binary (a `bin` dir's parent: `~/.bun`, the fnm node version, `~/.local/share/claude/versions`, `~/.opencode`), and its own credential file. Your real Workit config and state dirs, the host config dirs (`~/.claude` but the credential file, `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.config/opencode`, `~/.pi`, `~/.local/share/opencode`) and every other project or file in your home are not readable. A candidate dir that holds the home or a guarded path is dropped. Each bench start lists the real home under the run's rules and prints `read confinement: on`, or `off (<reason>)` when the listing works. Both hosts start signed in under it (one `session-context` run each).
  Without Landlock (another OS, a kernel before 6.2) a case that permits a shell wrapper is refused unless you pass `--unconfined`; it then runs with detection only.
- **Open and limits.**
  - Landlock does not cover metadata: a bench agent can `chmod`, `chown` or `touch` a real file. A mode change on a guarded file is reported; nothing else is.
  - A bench agent can ask a service of yours that runs outside the sandbox to write for it (`systemd-run --user`, a tmux or docker socket). Such a write to a guarded file is detected within 2 s; to any other file it is not seen.
  - The temp dirs and `/dev` stay writable, so files there (other tools' scratch files) are not protected.
  - A change to a watched file is seen within 2 s, the watch interval, and the host is killed; the changed bytes stay until you act, so a live session that reads the file meanwhile sees them.
  - A bench agent can kill the runner, which ends detection. Under Landlock what it leaves running still cannot write your home. Everything the runner leaves on disk is writable and deletable by the same OS user, so the next start reports a leftover only if the agent left one and cannot prove it genuine; the digest the stopped run printed on your terminal is the only check, and it is yours to make.
  - A bench agent that attaches to the runner (ptrace, `/proc/<pid>/mem`) can change the snapshot in memory. With `kernel.yama.ptrace_scope` 1 or higher (Ubuntu's default) the kernel refuses a child attaching to its parent; with 0 nothing does.
  - The host's login (`~/.claude/.credentials.json`, the world's copy of `~/.claude.json`'s sign-in keys, the OpenCode provider keys) is readable by the bench agent by design: the host cannot sign in otherwise.
  - Under Landlock the bench protects your real Workit files from change and your home from being read, except what the read rules list: the system dirs (`/etc/passwd` names your home; `/run` holds your runtime sockets), the temp dirs (other tools' scratch files), the toolchain install dirs (global packages and caches under `~/.bun`, for one) and the main checkout's `node_modules`. What a model reads there is scrubbed only when the call names the path; a model that quotes it in its answer is caught only by the refusal, which knows only the private strings above.
  - Without Landlock reads are unrestricted: a case that permits a shell wrapper is refused (or runs with `--unconfined`), and every other case relies on the scrub and the refusal alone.
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
