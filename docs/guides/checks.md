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
the signal number (143 for SIGTERM). It prints:

```text
interrupted by SIGTERM (the caller stopped it, likely a tool timeout): run long checks in the background
```

An interrupted run is absent evidence: no gate counts it as passing or failing,
and the run before it on that head still stands. Run a long check in a
background shell instead of rerunning it in the foreground. A command that exits
143 on its own, with no signal sent to Workit, is still a failure. In a group, an
interrupted member stops the group.

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
  and what `resources.heavy` adds) queue for it, so a session holding the lease
  delays only them.
- Every member runs even when one fails. The exit code is 1 if any failed, and
  the last line names them (`FAILED typecheck (2/3 passed)`).
- `--json`, `--full`, `--wait`, `--no-wait` and `--timeout` pass through to each
  member.
- A repo with no `ci` group gets exit 2, the configured check names and how to
  declare the group.

A group member must be a configured check, and a group cannot share a name with
a check.

## Waiting for the heavy-check lease

Heavy checks share one machine-wide lease
([delivery guide](delivery.md#heavy-checks-share-the-machine)). From a check's
side:

- **`--timeout` covers the wait too.** A check run with `--timeout <s>` waits
  for the lease at most that long, and the command gets what is left, so a
  queued check never outlives the timeout its caller set. A wait that ran out
  exits 4 and says the check did not run. Without `--timeout`, the wait is
  `--wait <dur>`, else `resources.wait` (30 min).
- **A waiter says where it stands.** The first line names the holder with how
  long it has run, the queue position and an estimated wait:

  ```text
  workit: waiting for the heavy-check lease (1 slot): held by test, pid 4121, session s1, 4m 12s, /wt/a; queued at position 2, waiting up to 30m (--wait <dur> sets it); estimated wait ~13m (last measured runs)
  ```

  The estimate uses each check's last measured run in the ledger of the repo it
  runs in: the holder's time left, then the runs of the waiters ahead. A check
  never measured gives `no wait estimate yet (no measured run of <check>)`.
- **A holder in another checkout is not your run.** Subagents share the lead's
  session id, so a holder can show your own session. A check never joins or
  reports another run: when a holder runs in another worktree, the wait line
  says so (`test, pid 4121 is another checkout's run (/wt/b), not this
  check's: this check runs its own command in /wt/a`), and the check then runs
  its own command in its own checkout. Its summary line says
  `ran in <checkout> @ <head>`, its `--json` carries `checkout` and its own
  `pid` (`lease.holder` is the run it waited behind), and its ledger row
  records `checkout`, since every worktree of a repo shares one ledger.
- **A verdict follows its checks' head.** `workit ledger verdict` refuses
  (`head_moved`, naming both SHAs) when the run named by `--evidence`, or the
  recording session's last check run on the branch, ran on an older head and a
  code change landed since, and names the changed files: run the checks on the
  new head, then record. A follow-up the verdict would carry anyway (the rules
  `workit pr status` reads as "carried": docs or changelog only, tests only
  under a `unit` verdict, a rebase with the patch unchanged) does not refuse.
- **`workit lock status`** shows each holder's time left (`~9m left`, or
  `past its last 14m run`) and each waiter's estimated wait; `--json` adds them
  under `estimates`.
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
