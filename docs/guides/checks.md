# Named checks and the `ci` group

`workit check <name>` runs a command declared in `.workit/checks.json` and records
the result as evidence. A repo also declares **groups**: named lists of those
checks that `workit check <group>` runs one after another.

If the checked command removes the checkout it ran in (a worktree deleted while
the check ran), nothing is recorded: Workit prints the path, says the result was
not recorded, and exits with the command's own exit code. It never recreates the
removed directory.

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
  A source it cannot read leaves the gate open. `workit doctor` shows the
  source on its `pressure_gate` row; `resources.pressure: false` in your
  workspaces.json turns the gate off.
