# Background processes

Dev servers and containers an agent starts tend to outlive the work. Workit
runs them through a process registry instead, so it knows who started each
one, how much memory it holds, and who may stop it. The session that started
a process stops it when its work ends, unless you say to keep it. The one
kind of process Workit stops without having started it is an automation
browser that a session's browser tool launched
([automation browsers](#automation-browsers)). It never touches any other
process, including your own browser.

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

## When a session ends

When the host session ends, Workit stops the processes it registered, and its
workers' processes too. It runs `workit stop --session <id> --reason
session-end` in the background, so the host never waits on it. Kept rows and
rows in a workspace with `cleanup: keep` keep running. So does anything
started from a plain terminal. The log says why each one was kept.

A session that goes on stops nothing: Claude Code `/clear` and `/resume`, or
Pi's `/new`, `/resume`, `/fork` and `/reload`. The processes stay with the
live host process. A worker's own end stops nothing either, because its
processes belong to its lead.

When a session starts, Workit stops the orphans dead sessions left behind:
`workit stop --orphans --reason session-start`. It does this at most once
every 10 minutes per user.

Each host has its own end event. OpenCode has neither a start nor an exit
event. A deleted OpenCode session's processes stop. The reap runs on the first
event the plugin sees after OpenCode starts. A server that exits leaves its
processes to the next reap, from any host. The [host parity
table](../agents/hosts.md#host-parity) has the details per host.

## Automation browsers

Browser tools start their own Chrome: agent-browser, the chrome-devtools MCP
server, Playwright and Puppeteer. These browsers often outlive the session
that started them. Workit finds them in the process table and handles them
like any other registered process (kind `browser`). The session that started
one stops it when it ends. Once that session's host process is gone, the
browser is an orphan.

A process counts as an automation browser only if all of these are true:

- It is a Chrome, Chromium, Chrome for Testing, headless shell or Edge main
  process. Its renderer and GPU child processes (`--type=…`) are not counted.
- Its command line has `--remote-debugging-port` or `--remote-debugging-pipe`.
- Its `--user-data-dir` is in a temp dir (`/tmp`, `/var/folders`, `%TEMP%`)
  or in a profile dir an automation tool uses: `~/.cache/chrome-devtools-mcp`,
  `~/.cache/ms-playwright`, `~/.cache/puppeteer` or `~/.agent-browser`. A
  browser binary one of those tools downloaded also counts.

Workit never touches your own browser. A Chrome without the debugging flags
is never counted. Neither is one on its default profile
(`~/.config/google-chrome`, `~/Library/Application Support/Google/Chrome`,
`%LOCALAPPDATA%\Google\Chrome\User Data` and their Chromium and Edge
equivalents), even with the flags. The same goes for one on a profile dir you
picked yourself. Before comparing, Workit resolves `..`, extra slashes and symbolic
links in the profile path. A temp-dir path that leads into a default profile
is therefore still your default profile.

A browser is registered only when Workit can prove which session owns it:

- Its own environment names the session (`WORKIT_SESSION_ID` or the host's
  session variable). This proof still holds after the tool that launched it
  has exited. Workit can only read another process's environment on Linux.
- One of its parent processes is a session's host process: the pid and start
  time that session's live-session marker records. This can only be read
  while that host process runs. Workit records the owner at that scan, so the
  browser stays owned after its host dies. If one host process runs several
  sessions, the browser gets no session. It is then stopped only as an
  orphan, once that host process is gone.

Workit scans the process table each time `workit stop --session`,
`workit stop --within`, `workit stop --orphans` or `workit gc --procs` runs.
A browser it finds but cannot link to a session is listed as `pid:<pid>` and
is never stopped. To end one of these, close it yourself.

A browser stop signals the browser's process group if it leads one (Puppeteer
and Playwright start it that way). Otherwise only the browser process gets the
signal, never the group of the tool that launched it. As with any stop, the
start time is checked before each signal.

The scan reads `/proc` on Linux, makes one `ps` call on macOS and one bounded
PowerShell `Win32_Process` query on Windows. On Linux with about 700
processes it takes about 16 ms.

## Limits

- Automation browsers on Windows are found and classified the same way, but
  they are never stopped. Workit can't prove who owns one: Windows records no
  host process for a session, and Workit can't read another process's
  environment there. Each one is listed as `pid:<pid>`; close it yourself.
- On macOS, Workit can't read a browser's environment, so only its parent
  processes can link it to a session. A browser whose launcher detached from
  the host (agent-browser's daemon) loses that link: it is listed, not
  stopped. A browser an MCP server or a test runner starts under the host
  stays linked.
- Windows: there is no process group or start time Workit can check, so
  `workit stop` asks the supervisor that holds the process instead (a stop
  request it polls for). The supervisor ends the child's tree (`taskkill /T`,
  then `/T /F` after 10 s); it holds the child's handle, so the pid is still
  that process. When the supervisor is gone, the stop only reports the process
  and signals nothing; end it in Task Manager.
- Marking a process kept comes with the end-of-work cleanup in a later
  release (a ledger decision naming `proc:<id>`); the registry already honors
  the keep flag.

## Where the files live

| Path | What |
| --- | --- |
| `<state>/threads.db` | the registry rows (`procs` table, [threads spec](../specs/threads.md)) |
| `<state>/procs/logs/<id>.log` | the process's stdout and stderr |
| `<state>/procs/notices/<session>.json` | RSS ceiling notices for one owner session |
| `<state>/procs/rows/<id>.json` | per-row facts the table has no column for (name, command, host pid start, containers, start state; [sidecar](../specs/threads.md#the-per-row-sidecar)) |
| `<state>/procs/rows/<id>.stop` | a pending stop request for the row's supervisor (the Windows stop path) |
| `<state>/procs/teardown.log` | what each session-end stop and session-start reap did, including why a row was kept (restarted past 1 MB) |
| `<state>/procs/reap-at-start.stamp` | when the last session-start reap ran |

`<state>` is Workit's state dir (`workit dir state`).
