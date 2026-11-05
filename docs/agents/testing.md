# Testing

Read before running anything beyond `bun run test`, or before adding a suite
that packs, installs or needs docker.

## Node 24+

Tests spawn the real `node` on PATH for packed adapters, doctor and
installers. `test/shared/node-guard.ts` (a `bunfig.toml` preload) exits before
any test runs when that `node` is older than the support-matrix minimum
(24); switch with `fnm use` (reads `.node-version`).

## Local pins

When a live host (Claude Code `--plugin-dir`, OpenCode `file://` pin, Pi local
install) loads a checkout, never run root `bun run build` or `bun run check` in
it: they replace bundles the host has loaded. Run lint, format, typecheck and
tests directly, work in a separate worktree, or build into an external target
directory (`bun packages/<pkg>/scripts/build.ts <target-dir>`).

## Real-host tests

Day to day, every host runs the released npm packages, unpinned, so
`workit upgrade` keeps them current. To verify a change in real conditions,
point the host at a worktree of the branch for the test only, then switch back.

| Host | Point at the worktree | Pick up a change | Switch back |
| --- | --- | --- | --- |
| Claude Code | `claude --plugin-dir <wt>/packages/workit-claude-code` (loads in place, shadows the marketplace plugin) | hook scripts on the next call; `/reload-plugins` for hooks.json, skills, MCP | start `claude` without the flag |
| OpenCode | `"plugins": ["file://<wt>/packages/workit-opencode"]` after `bun packages/workit-opencode/scripts/build.ts` | rebuild; OpenCode 2.x loads plugin code live, no restart; `opencode reload` for config | `"plugins": ["@brainervirus/workit-opencode"]`, then `opencode reload` |
| Codex | `codex plugin marketplace add <wt>`, then `codex plugin add workit@<name>` | new Codex session; re-trust changed hooks in `/hooks` | remove that marketplace, `codex plugin add workit@workit` |
| Cursor | copy `<wt>/packages/workit-cursor` over `~/.cursor/plugins/local/workit` | `Developer: Reload Window` | `workit init`, select Cursor |
| Pi | `pi -e <wt>/packages/workit-pi` for one run, or that path in `~/.pi/agent/settings.json` `packages` | `/reload` | `pi remove <path>`, `pi install npm:@brainervirus/workit-pi` |

Never repoint a host the user is working in. If the change needs a restart or
reload of a host that is in use, test it headless instead (`claude -p`,
`opencode run --standalone`, `codex exec`, `cursor-agent -p`, `pi -p`) or in a
container (OpenCode has one: `WORKIT_V2_HARNESS=1 bun test
test/opencode-v2/contract.test.ts`). If neither fits, ask the user to save their
work and close that host before you switch it, and switch it back after.

## Tiers

`bun scripts/test.ts <unit|packaging> [bun test args]` selects a tier; the
`PACKAGING` list in `scripts/test.ts` defines the split. Plain `bun test`
runs everything; `bun test <path>` runs one file.

- `bun run test`: the unit tier, everything not in `PACKAGING`, including
  `test/acceptance/` (`bun run test:acceptance` runs just
  `test/acceptance/deterministic.test.ts`).
- `bun run test:packaging` (slow): packs tarballs, runs npm and Pi installs and
  drives doctor against installed artifacts. Packing builds each adapter into
  a sandbox first (`packWorkspacePackages` in
  `test/shared/helpers/packages.ts`), so neither tier needs `bun run build`
  first.

## Agent-behaviour eval

Changes to what agents see (hook text, nudges, denials, tool schemas, skills,
verb output) are proven against real failures, not prose (#425).

- `test/behavior/cases/*.json`: one sanitised hook payload or CLI call from a
  real session, with what the agent must and must not see (`kind`,
  `require`/`forbid` regexes, `maxLines`, `exit`). A case with `"open": "#n"`
  is a known defect and runs as an expected failure: the PR fixing #n drops
  the mark, so the case goes red to green. Add the case before the fix.
- `docs/qualification/context-budget.json`: the size of every agent-facing
  item. `test/behavior/context-budget.test.ts` fails on any drift; `bun run
  write:budget` rewrites it. A PR that grows a value needs the
  `context-increase` label (`.github/workflows/context-budget.yml`); cut
  elsewhere first.
- A skill or agent edit also trips the 66-line cap
  (`test/workit-core/skill-set.test.ts`), the pinned phrases
  (`test/workit-core/methods.test.ts`) and `generated-copies.test.ts`, which a
  targeted test misses. `workit fanout brief` adds a `skills:` VERIFY line to
  any slice whose SCOPE has a `skills` or `agents` path segment outside a
  `docs` dir: `workit check skills` when the slice worktree's
  `.workit/checks.json` defines a `skills` check or group, else these four
  files by name, else "run the repo's skill and context-budget checks".

### Layer 2: model-in-the-loop cases

`packages/workit-claude-code/evals/*/case.yaml` runs real models in a scaffold
repo and grades the trace with regexes. The retro classes (#425) are one case
each: `isolated-implementer-plain-git`, `verifier-verdict-first-try`,
`heavy-test-tail-once`, `check-output-bounded`, `read-only-no-nudge`,
`finding-key-self-correct`, `git-status-guess` (scaffold
`evals/scaffold/feature-repo.sh`: offline, a feature branch, a noisy
configured `test` check). Every retro case is `runs: 1` and `max_turns` ≤ 6. The
merge-granted / endpoint-pr hint needs a real forge and has no case; layer 0
covers it. Several graders are negative regexes (`^(?![\s\S]*…)`) because the
case format has no "absent" grader; calibrate a pattern on its first real run.

`.github/workflows/claude-eval.yml` runs the suite nightly and on the `eval`
label as a matrix over `--model sonnet` and `--model haiku` (aliases, no new
pin: only the claude CLI version is pinned in the support matrix), each leg
with `--max-cost-usd 1.5` (about $3 a night in all) and its own
`claude-eval-<model>` artifact. The score is a report, not a PR gate
(`--threshold 0`): read the per-case pass rate per model before and after a
wording change. Weak-model parity for Claude (#435) is measured here;
OpenCode weak models and re-injecting the contract after a model switch are a
separate slice.

Run one case locally (paid; needs a Claude credential):

```bash
claude plugin eval packages/workit-claude-code --case <name> --model haiku \
  --runs 1 --scaffold --trust-plugin --allow-tools Bash
```

## CI shards

Each leg runs `bun scripts/test.ts ci <ubuntu|macos|windows> <i>/<n>`: bun
picks the shard's files (`bun test --shard`), balanced by the per-file
durations in `test/timings/<leg>.json`. Ubuntu runs the unit tier as four
shards plus a separate packaging job; macOS (three shards) and Windows (twelve)
run `test/workit-core` and `test/artifacts`. Ubuntu and macOS shards spread
their files across workers (`bun test --parallel`); Windows shards run serially,
since its spawn-heavy tests timed out under parallel load (#415), with
`--isolate`: every file gets a fresh `process.env`, cwd and globals, as
`--parallel` gives each worker's files. Without it a file's leftover env (a
`WORKIT_CONFIG`, `PATH` or `HOME`) failed later, unrelated files by shard
order. The local `unit` and `packaging` tiers isolate too. The test preload
also turns off git auto-maintenance (`GIT_CONFIG_*`) in throwaway repos. Aggregator jobs
keep the required check names (`test (ubuntu-latest)`, `test (macos-latest)`,
`test (windows-latest)`).

No file may dominate a Windows shard, since those run serially: the forge suites
are split by area under `test/workit-core/forge/` (shared harness in
`forge/shared.ts`). Windows shards cache the installed `node_modules` trees,
keyed by OS, Bun version and the `bun.lock` hash with no fallback key (a cold
`bun install` took 70-75 s; the bun download cache restored slower than that).
`bun install --frozen-lockfile` still runs after the restore.

Every shard uploads the durations it measured (`timings-<leg>-<i>` artifacts).
Refresh the committed files when the balance drifts: `gh run download <run>
--pattern 'timings-*'` from a green main run, then for each file keep the value
from the shard that ran it (the one whose value differs from the committed
file) into `test/timings/<leg>.json`. A file missing from the timings lands on
a shard unweighted, which is how the Windows shards drifted from 2 to 4.5 min.

### Timeouts

`bun scripts/test.ts` (both tiers and every CI shard) passes a 15 s per-test
default instead of bun's 5 s: git- and spawn-heavy tests stretch past 5 s when
files share the machine, in CI and in a local full run. A `--timeout` you pass
wins. The numbers live in one place, `test/shared/timeouts.ts`; never write a
per-test number for load:

- `spawnHeavyTimeout()`: 15 s, 45 s on Windows. Use it for a file whose tests
  run git or spawn the CLI (`setDefaultTimeout(spawnHeavyTimeout())`) or as the
  third argument of one such test.
- `windowsScaled(ms)`: a budget you need for another reason (a worker deadline,
  a spawn `timeout`) scaled 3x on Windows.

A timeout under load is a symptom first: look for a held handle (an EBUSY `rm`
on Windows wants `rmSync(..., { maxRetries, retryDelay })`), a busy-wait, a
network round trip (`npm install --prefer-offline` against the restored npm
cache) or an unbounded spawn before scaling the budget. Jobs time out after
15 minutes; nothing retries a failed test.

### Docs-only PRs

PRs touching only `docs/**` (outside `docs/qualification/`) or root/`.github/`
Markdown skip the test legs (`changes` job, covered by
`test/artifacts/ci-changes.test.ts`). The test files that read other repo docs
(`test/artifacts/docs-commands.test.ts`, `test/workit-cli/dir.test.ts`) run in
"fast checks" as `docs-tests`, which every PR runs; add a new docs-reading test
there.

### Line endings

`.gitattributes` checks every text file out with LF (`* text=auto eol=lf`), and
fixtures, `testdata`, goldens and snapshots carry their own `eol=lf` rule, so a
Windows checkout never turns a byte-compared fixture into CRLF.
`test/workit-core/gitattributes.test.ts` fails, naming the file, on any committed
fixture that resolves to neither `eol=lf` nor `-text`. A test that compares
bytes of a file outside those paths needs its own `.gitattributes` rule.

## Opt-in suites

- OpenCode v2 docker suites (`test/opencode-v2/{contract,lifecycle,matrix}.test.ts`) sit
  in the packaging tier but report as skipped unless `WORKIT_V2_HARNESS=1` is
  set and docker is available. CI runs them only on demand or with the
  `opencode-v2` PR label (`.github/workflows/opencode-v2-harness.yml`).
- Claude Code plugin evals run nightly, on demand or with the `eval` PR label
  (`.github/workflows/claude-eval.yml`).

## CI-only checks

CI also runs `bun run knip` (unused files/exports and reachability),
`bun run doctor` (react-doctor on the CLI UI; success ends with `react-doctor: scanned <n> files, 0 issues`, any warning exits non-zero, and a run that never prints that line did not pass), actionlint and zizmor, which
`bun run check` does not, and lints the PR title with commitlint. Run knip after deleting or moving exports.

## Git hooks

`lefthook.yml` runs `node_modules/.bin/oxfmt --check` and `oxlint` on staged
files, never `bunx` (an unpinned download in a worktree without an install). The
format job only checks: `git commit -- <paths>`, which `workit git commit` runs,
hooks against a temporary index, so a fix made there reaches the commit but not
the real index and leaves `git status` at `MM`. After this fix, reinstall once
per clone with `bun run hooks:install`; it also removes the absolute lefthook
path (for example another worktree's `node_modules`) that `lefthook install`
bakes into the shared `.git/hooks`. `test/artifacts/install-hooks.test.ts`
covers both with a temp repo and a linked worktree.
