# Named checks and the `ci` group

`workit check <name>` runs a command declared in `.workit/checks.json` and records
the result as evidence. A repo also declares **groups**: named lists of those
checks that `workit check <group>` runs one after another.

`workit check --list` (or `workit check` with no name) prints each configured
check with its command, and each group, and exits 0. A name that is not
configured fails and lists the configured ones, so a check name is never a
guess.

If the checked command removes the checkout it ran in (a worktree deleted while
the check ran), nothing is recorded: Workit prints the path, says the result was
not recorded, and exits with the command's own exit code. It never recreates the
removed directory.

A check its caller stops (a host's tool timeout sends SIGTERM, or Ctrl-C) is
recorded as `interrupted` with the signal, not as `failed`, and exits 128 plus
the signal number (143 for SIGTERM). Workit forwards the signal to the command,
and the run counts as interrupted only when Workit itself received SIGINT,
SIGTERM or SIGHUP and the command died of that signal. It prints:

```text
interrupted by SIGTERM (the caller stopped it, likely a tool timeout): run long checks in the background
```

An interrupted run is absent evidence: no gate counts it as passing or failing,
and the run before it on that head still stands. Run a long check in a
background shell instead of rerunning it in the foreground. In a group, an
interrupted member stops the group.

Every other ending is the command's own result:

- A command that kills itself with a signal while no signal reached Workit is
  `failed`. The row names the signal and Workit prints
  `killed by SIGTERM (exit 143; no signal reached workit)`. A command that
  exits 143 on its own is `failed` too. When Workit received one signal and the
  command died of another, the run is `failed` and the message names both
  signals (for example: killed by SIGTERM, exit 143, while Workit had
  received SIGINT).
- A command that catches the forwarded signal and exits on its own code (say
  3) is recorded with that code: `failed`, exit 3 (or `passed` on 0).

```json
{
  "checks": {
    "lint": ["bun", "run", "lint"],
    "knip": ["bun", "run", "knip"],
    "test": ["bun", "run", "test"]
  },
  "groups": { "ci": ["lint", "knip", "test"] },
  "resources": { "heavy": ["knip"] }
}
```

## Mirror CI locally

Declare the checks your CI workflow runs as the `ci` group, then run
`workit check ci` before you push. A PR then never goes red on a gate that never
ran locally.

- Each member runs as its own recorded check: one evidence row per name.
- Light members (`resources.light`, default lint, typecheck, format) run first
  and never take the heavy lease. Heavy members (`test`, `build`, `packaging`,
  what `resources.heavy` adds, and any member whose own entry sets `"heavy"`)
  queue for it, so a session holding the lease
  delays only them.
- Every member runs even when one fails. The exit code is 1 if any failed, and
  the last line names them (`FAILED typecheck (2/3 passed)`).
- `--json`, `--full`, `--wait`, `--no-wait` and `--timeout` pass through to each
  member.
- A repo with no `ci` group gets exit 2, the configured check names and how to
  declare the group.

A group member must be a configured check, and a group cannot share a name with
a check.

## A check's own `heavy`

A check entry can also be an object with its command and its own `heavy`:

```json
{
  "checks": {
    "test": { "command": ["bun", "run", "test"], "heavy": true },
    "bench": { "command": "bun run bench", "heavy": "io" }
  }
}
```

- `"heavy": true` queues the check for the heavy-check lease, like listing it
  under `resources.heavy`.
- `"heavy": "io"` marks it network-bound: a run that mostly waits on a model
  API or the network. It runs without taking a CPU slot, even with every slot
  held, while the memory budget and the pressure gate allow; when memory is
  short it queues like any heavy check. An ad-hoc run passes `--io` for the
  same (`workit check --io --name bench -- bun run bench`).

Any other `heavy` value, or any key but `command` and `heavy`, makes the
config invalid, and the error names the allowed values. A repo cannot mark a
check light with `heavy`: only the machine owner's `resources.light` does.

## The heavy-check lease

Parallel agents run their checks on one machine. Workit runs each heavy check
under a machine-wide lease, so two test suites never start at once, and on
Linux it gives each one its own memory and CPU limit.

```bash
workit check test                 # heavy by default: waits for the lease, then runs
workit check --heavy -- npx jest  # an ad-hoc command takes the lease only with --heavy
workit check --name unit -- bun test a.test.ts  # a light ad-hoc command: no lease, runs at once
workit check --heavy -- bunx oxfmt a.ts         # a formatter never takes the lease, even with --heavy
workit check test --timeout 1200  # bounds the lease wait and the run together
workit check test --no-lease --reason "<why>"  # run it now, outside the lease (for you, not for briefs)
workit lock status                # who holds the lease; `workit lock wait` waits for a slot
```

- **Which checks are heavy.** The named checks `test`, `build` and `packaging` are heavy by
  default; `lint`, `typecheck` and `format` are light and never take the lease
  (`resources.light` in workspaces.json changes the list). An ad-hoc
  `workit check -- <cmd>` takes the lease only with `--heavy`, and never when
  it is a formatter (`oxfmt`, `prettier`, `cargo fmt`, `bun run format`) or a
  linter whose every target is a file (`eslint a.ts b.ts`, not `eslint src`):
  it runs at once and says why. A raw heavy shell command an agent runs (`npx jest`, `npm run test:ci`) is rewritten
  through the lease (Claude Code, OpenCode, Pi), or denied with the exact
  rewrite on Codex, Cursor and Claude Code in auto mode (which refuses a call a
  hook changed). A
  chain with heavy parts is denied with each part's lease command, and a
  command a host permission rule names runs outside the lease
  ([verification guide](verification.md#heavy-commands-and-the-lease)).
- **The lease is a weighted budget and a queue.** It is shared across every
  worktree and agent of the user, and counted in units (`resources.slots`,
  default 1, or a units `budget` with per-check `weights`) and in memory (the
  RAM less a `reserve`, each check charged its measured peak RSS; see
  [heavy-check budget](configuration.md#heavy-check-budget)). A [pressure gate](#waiting-for-the-heavy-check-lease)
  can hold a heavy check for at most 5 min. A heavy check
  that finds no room joins the queue
  ([waiting for the lease](#waiting-for-the-heavy-check-lease)) and prints a
  status line every 30 s. It waits up to `--wait <dur>`
  (`90`, `90s`, `30m`, `1h`; default `resources.wait`, 30 min). At that limit
  it re-queues once in the same place, printing the estimated wait, and gives
  up only at the second limit, naming the exact command to run again with a
  `--wait` sized to the estimate. A wait bounded by `--timeout` never
  re-queues past it, and `--no-wait` refuses at once.   A foreground shell tool call (about 2 min on Claude Code and OpenCode) can
  end before a long wait: run long checks in the background. The lease is
  released when the check ends, and a queued check gives up its place when it
  stops waiting, also on Ctrl-C or SIGTERM. Leases are files
  under the Workit state dir (`~/.local/state/workit/leases` on Linux and macOS).
- **`--timeout` bounds the whole check.** The lease wait counts toward
  `--timeout`, so a queued check never outlives the timeout its caller set:
  the wait is at most the timeout, and the command gets what is left. When a
  slot frees with less than 10 s (or a quarter of the timeout, if smaller)
  left, the check gives up as a wait timeout and never starts the command.
- **Exit codes.** A check that never ran because of the lease exits 4
  (`busy`): `--no-wait` with every slot held, a wait that ran out (`--wait`
  or `--timeout`), a wait that left too little of `--timeout`, or
  `workit lock cancel`. A command killed by `--timeout` also exits 4; every
  other run exits with the command's own code. The two timeouts share 4
  because Workit's codes (0-5) have no free one and any other number could be
  a command's own; `--json` tells them apart: `"code": "busy"` with
  `data.lease` for the wait, `"code": "failed"` with `data.timedOut: true`
  for the command. The stderr line says which (`the check did not run`, or
  `timed out after`).
- **Stuck holders.** A holder is shown `stuck?` once it holds its slot past
  its limit, or its check printed nothing and used no CPU for 5 min. The
  limit is 1.5 times the check's last measured run, never below
  `resources.maxHold` (default 15 min), which alone applies to a check with no
  measured run; so two full suites that each take 25 min are not flagged at
  20 min. `workit lock reap` frees a stuck slot. The next acquirer reclaims
  one itself only when it is past 3 times its limit and silent for its limit.
- **Fanout plans.** `workit fanout plan` warns when one wave has more slices
  whose VERIFY runs a full suite (a heavy named check such as
  `workit check test`, or a heavy command that names no file) than the
  machine has lease slots: the rest would each queue a whole suite run. Give
  each slice its targeted test files instead and run the full suite once at
  fan-in.
- **Stale leases.** A lease stays held while its `workit` process runs. If
  `workit` is killed outright (SIGKILL), the lease stays held while the
  check's process group or scope still has processes, so two heavy checks
  never overlap. The next acquirer reclaims a lease, and says so, once those
  are gone, or when it was taken before a reboot (the kernel boot id on
  Linux, the boot time elsewhere). A reused pid does not keep a lease: the
  holder's process start time (`/proc` on Linux, `ps -o lstart=` on macOS)
  must still match. Where it cannot be read (Windows), a lease also ends
  after the check's `--timeout`, or 6 hours without one, plus a minute.
- **Nested checks.** A heavy check started by another heavy check reuses
  that check's lease (`WORKIT_LEASE`) and does not wait for it. On Linux the
  lease must belong to one of the process's ancestors, so a leaked
  `WORKIT_LEASE` cannot skip the queue.
- **The scope (Linux).** If a user systemd manager is running and has the
  `memory` and `cpu` controllers delegated (cgroup v2), the check runs under
  `systemd-run --user --scope -p MemoryMax=<m> -p CPUQuota=<c>` as the unit
  `workit-check-<id>-<pid>.scope`. When the check passes its limit, the
  kernel kills the check alone, not the desktop session. Without such a
  manager (no systemd, not delegated, macOS, Windows), the check runs as
  before and Workit says so once per session. If `systemd-run` itself fails
  to start the scope, the check runs again without one; systemd-run's error
  line is not shown as check output. `workit doctor` starts a throwaway scope and reads
  its cgroup back, so its `heavy_scope` row says whether the limits really
  apply here, not only whether systemd accepted them.
- **`--json`** adds `lease` (`slot`, `waitedMs`, the `holder` it waited on
  with pid, check, cwd and session, `reclaimed`, `inherited`) and `scope`
  (`unit`, `memoryMax` in bytes, `cpuQuota`, or `unit: null` with a
  `reason`). Both are `null` for a check that is not heavy; a light command
  run with `--heavy` adds `light` (`kind`, `tool`, `reason`). A wait that
  gave up reports `data.lease.requeuedAfterMs`, `estimatedWaitMs` and the
  `retry` command.

Configure it under `resources`. The machine's limits come from the matching
entry of your `workspaces.json`. A repo's `.workit/checks.json` can
only tighten them, so a repo cannot break the machine-wide limit: it can add
`heavy` checks, lower `memoryMax`, `cpuQuota`, `budget` and `maxHold`, raise
`reserve` and a check's `weights`, and set its own `wait`; its `slots`,
`scope`, `light` and `pressure` are ignored with a warning.

```json
{
  "workspaces": [
    {
      "name": "work",
      "glob": "/home/me/work/**",
      "resources": {
        "slots": 1,
        "memoryMax": "40%",
        "cpuQuota": "70%",
        "scope": true
      }
    }
  ]
}
```

```json
{
  "checks": { "test": "npm run test:ci", "e2e": "npx playwright test" },
  "resources": { "heavy": ["e2e"], "memoryMax": "8G", "wait": 900 }
}
```

| Field           | Default                      | Where     | Meaning                                                                |
| --------------- | ---------------------------- | --------- | ---------------------------------------------------------------------- |
| `heavy`         | `test`, `build`, `packaging` | both      | Named checks that take the lease; a repo only adds to the list         |
| `light`         | `lint`, `typecheck`, `format` | workspace | Named checks that never take the lease; a repo cannot set it           |
| `slots`         | `1`                          | workspace | Heavy checks that may run at once on the machine (1-64)                |
| `budget`        | RAM less `reserve`           | workspace | Weighted budget: units (`3`) or memory (`"24G"`, `"60%"`); a repo can only lower it |
| `reserve`       | 25% of RAM, 2-6 GiB          | workspace | Memory kept for the desktop; a repo can only raise it                  |
| `weights`       | 1 unit, measured peak RSS    | workspace | Per check: units (`2`) or a fixed memory charge (`"6G"`); a repo can only raise one |
| `pressure`      | `true`                       | workspace | `false` turns the PSI/load pressure gate off                           |
| `memoryMax`     | `40%` of RAM                 | both      | Scope `MemoryMax`: a percent of total RAM, or a size such as `8G`      |
| `cpuQuota`      | `70%` of all CPUs            | both      | Scope `CPUQuota`: a percent of the whole machine, or a CPU count (`4`) |
| `wait`          | `1800`                       | both      | Seconds (or a duration such as `"30m"`) to wait for the lease before exit 4 |
| `maxHold`       | `900`                        | both      | Seconds (or `"15m"`) a holder may hold a slot before `stuck?`; the floor under 1.5x its measured run; a repo can only lower it |
| `scope`         | `true`                       | workspace | `false` keeps the lease but runs without a systemd scope               |
| `heavyCommands` | none                         | repo      | Extra shell commands the hook gates (`["mvn verify", "task test:*"]`)  |

An invalid field prints a `workit: resources:` warning and keeps the earlier
value, so a typo never turns the lease off. The lease lives in the CLI, so it
works the same on every host (Claude Code, OpenCode, Codex, Cursor, Pi):
each one runs checks through `workit check`.

### Reap, cancel and giving up

- **`workit lock reap`** frees a `stuck?` slot and records a `lease.reaped`
  ledger row naming the pid, session and command; the process itself keeps
  running, so stop it yourself if it is truly hung. CPU counts as a heartbeat
  on Linux and macOS; on Windows only output does, so raise
  `resources.maxHold` in your own config for a quiet long check.
- **Owners and cancel.** A queued check leaves the queue when the process that
  started it ends, and `workit lock status` drops dead waiters and frees dead
  holders' slots before it prints. `workit lock cancel [<pid|session|dir>]`
  (default: your session) ends your own queued checks without `kill`; each
  exits 4 with `cancelled while queued for the heavy-check lease`.
- **Gave up waiting.** A check whose wait ran out exits 4 and says `queued
  behind <holder>, <age>` in its output and in `--json` (`lease.queuedBehind`),
  so a verifier can report missing evidence instead of dropping it.

## Waiting for the heavy-check lease

From a check's side:

- **A waiter says where it stands.** The first line names the holder with how
  long it has run, the queue position and an estimated wait:

  ```text
  workit: waiting for the heavy-check lease (1 slot): held by test, pid 4121, session s1, 4m 12s, /wt/a; queued at position 2, waiting up to 30m (--wait <dur> sets it), then once more in the same place; estimated wait ~13m (last measured runs)
  ```

  The estimate uses each check's last measured run in the ledger of the repo it
  runs in: the holder's time left, then the runs of the waiters ahead. A check
  never measured gives `no wait estimate yet (no measured run of <check>)`.
- **Short checks go first.** The queue serves the shortest measured run first,
  also among one session's checks (all agents of one lead share a session), so
  an 8-second suite never waits behind a queued 15-minute one. A waiter queued
  5 minutes goes ahead of every newer one, so a long suite is overtaken for at
  most that long. A check never measured ranks as a 15-minute run and keeps
  the old round-robin order among other unmeasured ones.
- **A smaller check backfills.** A waiter whose charge fits the free units and
  memory runs ahead of a bigger one that does not fit yet. Once that bigger
  waiter has waited 5 minutes, nobody behind it takes what it needs
  ([heavy-check budget](configuration.md#heavy-check-budget)).
- **Checks under 30 seconds run without a slot.** A heavy check whose last
  measured run took under 30 s starts at once, even with every slot held,
  while its memory fits the budget and the pressure gate is open:

  ```text
  workit: running without a heavy-check slot: its last measured run took 8s, under 30s, and its memory fits the budget
  ```

  Otherwise it queues, first in line. A network-bound check (`"heavy": "io"`,
  `--io`) does the same whatever its runtime. A check never measured always
  queues for a slot.
- **A holder in another checkout is not your run.** Subagents share the lead's
  session id, so a holder can show your own session. A check never joins or
  reports another run: when a holder runs in another worktree (one nested
  inside yours included: checkouts are compared by git top level), the wait
  line says so (`test, pid 4121 is another checkout's run (/wt/b), not this
  check's: this check runs its own command in /wt/a`), and the check then
  runs its own command in its own checkout. Its summary line says
  `ran in <checkout> @ <head>`, its `--json` carries `checkout` and its own
  `pid` (`lease.holder` is the run it waited behind), and its ledger row
  records `checkout`, since every worktree of a repo shares one ledger.
- **A verdict follows its checks' head.** An independent `verified` or
  `tests-verified` verdict (not `--self`) is refused (`head_moved`, naming both SHAs and the changed files)
  when its checks ran on an older head and a code change landed since:
  - a run named by `--evidence` that ran on another head or on a dirty
    worktree, unless a cited clean run of the same check is on the head;
  - for each check name, the recording session's latest run on the branch,
    when it ran on another head (or dirty) and no clean run of that name by
    the session is on the head. A configured check is cleared only by a
    configured run, never by an ad-hoc `--name <n> -- <cmd>`, and a check CI
    covered on the head is skipped.

  Whose runs count: a session is held to the runs stamped with it. No host
  stamps an agent id on a check run yet, so on Claude Code and Codex every
  subagent's `workit check` runs under the lead's session: a verdict recorded
  as the lead's session is held to all of them (any clean configured run of a
  check on the head, by any of its subagents, clears that check), while a
  verifier recording as a derived `<lead>:<agent>` id is held only through
  `--evidence` and the `check_missing`/`check_failing` gates until hosts stamp
  one ([host parity](../agents/hosts.md#host-parity)). A follow-up the verdict would carry
  anyway (what `workit pr status` reads as "carried": docs or changelog only,
  tests only under a `unit` verdict, a rebase with the patch unchanged) does
  not refuse, and `failed` or `blocked` always record. Run the checks on the
  new head, then record.
- **`workit lock status`** shows each holder's time left (`~9m left`, or
  `past its last 14m run`) and, for each waiter in serving order, its own
  check's last run and its estimated wait (`its last run took 8s, estimated
  wait ~3m`, or `no measured run` for that waiter alone); `--json` adds them
  under `estimates`. A `budget:` line gives the units and memory in use with
  the reserve and whether it is automatic or configured (`budget: 2 of 3
  units, 9.6 GiB of 26.0 GiB memory (6.0 GiB reserve, automatic)`), and
  `admitted (no slot):` lists the checks running without a slot: `short` ones
  (a last run under 30 s) and `io` ones. A network-bound check shows as `io`,
  queued (`bench (io), pid …`) or admitted (`io bench, pid …`); `--json` adds
  `budget` and `admitted`.
- **A dead holder frees its slot at once.** When a holder's `workit` process
  and its check are gone (crashed or killed), the next waiter takes the slot
  on its next poll, about a second later, and says it reclaimed it.
- **Targeted tests skip the lease.** An ad-hoc run takes the lease only with
  `--heavy`, so `workit check --name unit -- bun test <file>` runs at once and
  never waits, even with every slot held or `unit` listed in
  `resources.heavy`.
- **More slots.** One heavy check runs at a time by default. On a machine with
  room for more, raise `resources.slots` in your workspaces.json
  ([configuration](configuration.md#heavy-check-slots)), or give it a weighted
  `resources.budget`.
- **The memory budget and its default reserve.** Memory is counted in bytes of
  measured peak RSS: each heavy check is charged what it last used in that
  checkout (the lease samples it while the check runs), and a check never
  measured is charged its `memoryMax` (default 40% of RAM). With nothing
  configured, Workit keeps an automatic reserve for the desktop and IDE: a
  quarter of the RAM, at least 2 GiB and at most 6 GiB (6 GiB on a 32 GiB
  machine, 4 GiB on 16 GiB). Checks and dev servers share the rest, one heavy
  check at a time. `resources.reserve` overrides it. With only
  `resources.slots` set, checks are counted by slot as before; a dev server
  never takes a slot either way.
- **The pressure gate.** When the machine is already under pressure, a heavy
  check waits even with budget free, and the wait line names it instead of a
  holder:

  ```text
  workit: waiting for the heavy-check lease (1 slot): held by memory pressure: PSI some avg10 34.5% (critical at 10%); queued at position 1, ...
  ```

  Linux reads PSI (`/proc/pressure/memory` and `cpu`, `some avg10`; critical at
  10% memory or 80% CPU). Without PSI, Linux and macOS sample the 1-minute load
  (critical at 2 per CPU) and Windows samples CPU busy time (critical at 95%).
  A source it cannot read leaves the gate open, and pressure alone holds a
  check at most 5 minutes: a machine whose load never drops slows checks down
  but never stalls them. `workit doctor` shows the
  source on its `pressure_gate` row; `resources.pressure: false` in your
  workspaces.json turns the gate off.
