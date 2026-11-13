# Background processes

Dev servers and containers an agent starts tend to outlive the work. Workit
runs them through a process registry instead, so it knows who started each
one, how much memory it holds, and who may stop it. The session that started
a process stops it when its work ends, unless you say to keep it. Processes
Workit did not start are never touched.

## Start one

```sh
workit run --bg -- npm run dev
workit run --bg --port 4200 -- ng serve
workit run --bg --name api -- docker compose up
```

`workit run --bg` hands the command to a small supervisor that runs in its own
session and process group, so the agent's shell returning never takes it down.
It prints the id, the pid, the port and the log:

```text
started p1abc2def3 (dev) pid 41230 port 4200
log: ~/.local/state/workit/procs/logs/p1abc2def3.log
stop it: workit stop p1abc2def3
```

- The port is `--port`, else the first `localhost:<port>` (or `127.0.0.1`,
  `0.0.0.0`, `[::1]`) the log shows within 15 s.
- A command that exits within those 15 s was no server: `run` prints its output
  and returns its exit code, and nothing stays registered.
- One dev server per repo and name (`--name`, default `dev`). A second start in
  the same checkout prints the running one's id and port and starts nothing. A
  start from another checkout of the same repo fails and names the running
  server's directory, branch and owner: use it, stop it, or pick another
  `--name`.
- `docker compose up`, `docker-compose up` and `docker run` are docker rows.
  Workit records the containers the start created (the difference in
  `docker ps -q` before and after) and a stop runs `docker stop` on exactly
  those. It never runs `down`, `rm`, `-v` or `prune`. When docker can't be
  asked, the row is report-only.

## Memory

A server's measured memory counts against the heavy-check budget of the
checkout it runs in ([checks](checks.md)). It holds no lease slot or queue
place. A start that doesn't fit, or comes while the machine is under critical
memory or CPU pressure, is refused at once, never queued. The refusal says
how much the server needs and how much of the budget is free, names who holds
the rest, and gives the unblock: stop one of them (`workit stop <id>`), or
start this one outside the budget.

`--no-lease --reason "<why>"` starts it outside the budget and writes a
`proc.no_lease` ledger row with the reason.

The supervisor samples the process group's resident memory every 30 s. Past
the ceiling (the heavy scope's `memoryMax`, by default 40% of RAM) it writes
one notice for the owner session to
`<state>/procs/notices/<session>.json`, naming the process and
`workit run --bg --restart <id>`. It never restarts a process on its own.

## List and stop

```sh
workit ps                 # running: id, name, kind, pid, port, RSS, owner, age, directory
workit ps --all           # with the recently ended ones
workit stop p1abc2def3
workit stop --within .    # everything started in this checkout
workit stop --session <id>
workit stop --orphans     # processes whose owner's host process is gone
workit run --bg --restart p1abc2def3
```

A stop sends SIGTERM to the process group, waits 10 s, then sends SIGKILL.
Before each signal it checks the leader is still the process it recorded (its
start time): a pid that another process took is never signalled, and the row
ends saying so. Every stop writes a `proc.stopped` ledger row with the reason.

Who may stop what:

- Naming an id stops that process, even a kept one or one started from a
  plain terminal.
- `--session` and `--within` skip kept rows and rows started outside an agent
  session, and say why.
- An agent stops only processes its own session, or its workers, started. A
  person at a terminal may stop any registered process.

## Orphans

A registered process is an orphan only with proof that its owner is gone: the
host process recorded at start no longer runs, or its pid now belongs to
another process. Age is never proof. When the owner's host pid can't be told
(Windows, a host that hides it), the process is listed and never stopped
automatically.

```sh
workit gc --procs          # list the orphans
workit gc --procs --apply  # stop them, with a proc.stopped ledger row each
```

## Limits

- Windows: there is no process group or start time Workit can check, so
  `workit stop` there reports the process and leaves it running; end it in Task
  Manager.
- Marking a process kept comes with the end-of-work cleanup in a later
  release (a ledger decision naming `proc:<id>`); the registry already honors
  the keep flag.

## Where the files live

| Path | What |
| --- | --- |
| `<state>/threads.db` | the registry rows (`procs` table, [threads spec](../specs/threads.md)) |
| `<state>/procs/logs/<id>.log` | the process's stdout and stderr |
| `<state>/procs/notices/<session>.json` | RSS ceiling notices for one owner session |
| `<state>/procs/rows/<id>.json` | per-row facts the table has no column for (name, command, host pid start, containers, start state) |

`<state>` is Workit's state dir (`workit dir state`).
