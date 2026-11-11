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
bun scripts/eval/run.ts --host opencode --model deepseek-v4.1-flash --tier smoke
bun scripts/eval/run.ts --replay [--model haiku] [--check]    # re-grade stored transcripts, no model
```

- `--model` takes any Claude Code model alias or id. Results go to
  `evals/results/<model>/`, so `haiku` and `claude-haiku-4-5` are kept apart.
- `--budget-runs n` (default 3) caps how many `claude -p` runs one invocation
  starts. Cases past the cap are listed as `incomplete`; run again to continue,
  cached cases cost nothing.
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
`WORKIT_STATE_DIR` and `WORKIT_CONFIG_DIR` (branch policy: `feature/*`
allowed, `main` protected). Then, in the repo:

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
