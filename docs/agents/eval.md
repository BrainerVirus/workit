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

The transcript is stored with the world path (and Claude's project slug of
it) as `<world>`, the checkout as `<workit>`, the home dir as `~` and the
login name as `<user>`.

## Isolation and the tripwire

A bench run must never change your real Workit files (#822: a run rewrote
`~/.config/workit/workspaces.json` through a `python3` heredoc).

- **World HOME.** `HOME` and the four `XDG_*_HOME` bases point inside the
  world, so `~`, `$HOME` and every Workit path derived from them (config,
  grants, state, `approvals/`, the issued registry) resolve there. The host
  gets only its login, into real world dirs (so `cd -P ~/.claude/..` stays in
  the world): Claude Code's `~/.claude/.credentials.json` is symlinked (it
  refreshes in place; a host that replaces the link by rename has the new
  bytes written back to the real file, and the runner prints that) and
  `~/.claude.json` is copied; OpenCode gets a fresh `opencode.db` with the
  real one's schema and only its `credential`, `kv` and migration rows. No
  settings, `CLAUDE.md`, skills, hooks, plugins, sessions or caches.
- **Grants dir.** Workit reads grants from the account home (the OS record,
  never `$HOME`, D15). The bench runs the CLI and hooks from this checkout
  with bun, and under bun that record follows `$HOME`, so it is the world's
  too. A plugin dir that runs Workit on node would read the real one: the
  self-check catches that.
- **Self-check.** Before a case whose prompt names a shell wrapper (`bash`,
  `sh`, `python3`, `node`, `bun`, `eval`, ...), or whose allow list or
  permission mode lets one run, the runner resolves every guarded path in a
  child with the run's env (`run.ts --isolation-probe`: the real resolvers,
  then `workit dir config|state`, `workit grant show`, `workit workspace
  list`). A path outside the world, or a verb that prints no path, refuses the
  case: the host never starts and the run fails as `isolation`.
- **Tripwire.** At bench start, after taking the lock, the runner snapshots
  into its own memory the real:
  - config dir, whole (tokens, `vcs.json`, `templates/`, backups included),
    and the state files that grant or pick what runs
    (`host-permissions.json`, `host-permissions-backup/`, `node.json`): after
    each run every change is put back from that memory, in place (same inode,
    mode and mtime; a symlink as a symlink; a created file removed), after its
    bytes are saved under `rescued/<time>-<pid>/`;
  - state trees `approvals/`, `issued/`, `issued-tokens/` and `verdicts/`: a
    new, changed or missing file is reported and nothing is restored, since a
    live session adds and consumes them (a consumed approval put back would
    be re-armed).

  `leases/`, `logs/`, `hook-runs/`, `live-sessions/`, `worktrees/` and the
  other caches every session rewrites are not guarded. Any change fails the
  run as `outside_write` naming each path, the rescue dir (delete it once
  read; it may hold token bytes) and the transcript; no further run starts;
  exit 3. While a host runs, the restored set is re-checked every 2 s, and a
  change kills the host at once. `--replay` never re-grades such a run.
- **Digest and journal.** At arm the runner prints `tripwire armed: <N>
  files, digest <16 hex>` and writes a crash journal to
  `~/.cache/workit-bench-tripwire/journal/` (0700, files 0600), removed at
  every clean end or handled stop. The journal is never restored on its own:
  a later start that finds it writes nothing, drops it if it matches the real
  files, and otherwise prints `LEFTOVER` with each path and a `diff -u` line,
  exits 3 and runs nothing until you settle it with `--tripwire-restore
  <digest>` (refused unless the digest equals the one the stopped run printed,
  every path is inside the guarded roots, none sits under a recorded symlink
  and every blob matches) or `--tripwire-discard`. Both restores (from memory
  and from the journal) put a symlink back as a symlink and never write
  through one: a link planted above a guarded path is removed and the real
  dir restored, files are opened with `O_NOFOLLOW`, and a path that still
  cannot be put back is named while the rest is restored, the exit is
  non-zero and the journal stays.
- **Stopping and other runs.** Ctrl-C, SIGTERM or SIGHUP kill the host's
  process group; the run unwinds (its world removed, the real files restored
  from memory, the journal dropped), prints `STOPPED by <signal>`, writes no
  result for that run and exits 130, 143 or 129. One bench holds the tripwire
  at a time (`holders/<pid>.<start>`); a second one exits 4. A change you or a
  live session make to a restored file during a run is rolled back too, its
  bytes kept in `rescued/` (the 5 newest, none older than 7 days). Each start
  removes the `workit-eval-*` worlds a dead runner left in the temp dir. The
  start-time sweep also removes a directory named `workit-eval-*` under the
  temp dir that has no `.runner` marker and is older than 24 h, even if the
  runner did not make it.
- **Open and limits.**
  - A write by absolute path to a real file outside the guarded set is neither stopped nor seen. Landlock, which this kernel has and which needs no user namespace, can confine a host to its world; that is #824, not a final limit.
  - A change to a guarded file stands for up to 2 s, the watch interval, before the host is killed and the bytes are put back; a live session that reads the file in that window sees the changed bytes.
  - A bench agent that kills the runner ends the tripwire. Everything the runner leaves on disk is writable and deletable by the same OS user, so the next start reports a leftover only if the agent left one and cannot prove it genuine; the digest the stopped run printed on your terminal is the only check, and it is yours to make.
  - A bench agent that attaches to the runner (ptrace, `/proc/<pid>/mem`) can change the snapshot in memory. With `kernel.yama.ptrace_scope` 1 or higher (Ubuntu's default) the kernel refuses a child attaching to its parent; with 0 nothing does.
  - The host's login (`~/.claude/.credentials.json`, `~/.claude.json`, the OpenCode provider keys) is readable by the bench agent by design: the host cannot sign in otherwise.
  - Every other file in your home that your user can read, the bench agent can read; the bench protects your real Workit files from change, not your secrets from the model.
  - After the runner dies without its check (SIGKILL, power loss, a second Ctrl-C), a changed real file stays changed until you run `--tripwire-restore <digest>`; the next start reports it and runs nothing. The dead run's world, with its login copies in a 0700 dir, stays until that start.
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
| `expect.require`, `expect.forbid` | `{tool?, pattern, why}`: a regex on the Bash command, or on the JSON input for other tools |

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

plus its own `configuredCheck`, `require` and `forbid`. Each failure names the
call (`#4 Agent(workit:implementer: add hello)`). Changing a rule bumps
`GRADER_VERSION`; `--replay --check` exits 1 when a stored grade would change,
`--replay` rewrites them.
