# Threads: the per-user SQLite store

Status: part 1 (the store foundation) ships with #329. Decision mvi73gv3 (B1).

Workit keeps state shared by every session of one user in loose files under the
state dir. Parallel sessions race on them (#292, #311, #312), and the lease,
queue, worker liveness and process registry (#326, #328, #338, #339) need one
transactional store. Threads is that store: one SQLite file per user, opened
through one adapter on both runtimes Workit runs on.

## The file

- Path: `<state>/threads.db`, where `<state>` is Workit's state dir
  (`WORKIT_STATE_DIR`, else `XDG_STATE_HOME/workit`, else the platform default;
  [file-locations.md](../agents/file-locations.md)). SQLite keeps
  `threads.db-wal` and `threads.db-shm` beside it.
- Mode 0600, created by Workit before SQLite opens it (`O_EXCL`, so two
  processes creating it at once both end up on the one file). SQLite gives the
  `-wal` and `-shm` files the main file's mode. Windows has no POSIX mode; the
  file inherits the state dir's ACL.
- Journal mode WAL: readers never block the writer, and one writer at a time.
- `busy_timeout` 5000 ms on every connection: a writer that finds the write
  lock held waits and retries for that long, then fails with a clear
  "busy" error naming the file. Callers may pass a shorter wait.
- One user, one machine. No sync between machines; no transcripts (pointers
  only).

## Runtimes

One synchronous adapter (`packages/workit-core/src/store/threads/sqlite.ts`)
over the runtime's built-in SQLite:

| Runtime | Module | Loaded with |
| --- | --- | --- |
| Bun (`process.versions.bun` set) | `bun:sqlite` `Database` (`strict: true`) | `process.getBuiltinModule` |
| Node >= 24 (every host: support-matrix.ts; Pi's engines say >= 24) | `node:sqlite` `DatabaseSync` | `process.getBuiltinModule` |

Both are loaded at run time, never imported statically, so one source bundles
for either target. Named parameters are bare object keys bound to `$name` in
SQL on both. Node releases before 24.x's stable `node:sqlite` print
`ExperimentalWarning: SQLite is an experimental feature`; the adapter drops
exactly that warning while the module loads and lets every other warning
through.

## Schema

Forward-only migrations, one per version, each run inside `BEGIN IMMEDIATE`
(the version is read again inside the transaction, so two processes opening a
fresh file migrate it once). There is no down-migration.

A DB whose `schema_version` is above what this build knows is refused before
anything is written (no WAL switch, no migration): the error names both
versions and says to upgrade Workit. An older Workit never rewrites a newer
file.

### v1

`meta`: key-value facts about the file.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | TEXT PRIMARY KEY | `schema_version` |
| `value` | TEXT NOT NULL | `1` |

`procs`: the process registry (#328). One row per long-running process an
agent started through Workit (a dev server, a container, a browser).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | Workit's id for the process |
| `session` | TEXT | the Workit session that started it |
| `lead` | TEXT | the lead session when a worker started it |
| `host` | TEXT | claude-code, opencode, codex, cursor, pi or cli |
| `host_pid` | INTEGER | the host process, for orphan proof (ruling B) |
| `repo` | TEXT | the repo's git common dir |
| `cwd` | TEXT NOT NULL | where it was started |
| `branch` | TEXT | the checkout's branch at start |
| `pgid` | INTEGER | process group |
| `pid` | INTEGER | the leader's pid |
| `pid_start` | TEXT | the leader's start time, against pid reuse (ruling C) |
| `cmd` | TEXT NOT NULL | the command line |
| `kind` | TEXT NOT NULL | `server`, `docker`, `browser` or `other` |
| `port` | INTEGER | a server's port |
| `started_at` | TEXT NOT NULL | ISO 8601 |
| `rss` | INTEGER | last measured resident memory, bytes |
| `rss_at` | TEXT | when `rss` was measured |
| `keep` | INTEGER NOT NULL DEFAULT 0 | 1: cleanup leaves it running |
| `keep_ref` | TEXT | the ledger decision that kept it |
| `ended_at` | TEXT | when it stopped or was found gone |
| `end_reason` | TEXT | why |

Indexes: `procs(session)`, `procs(repo)`.

Writes to a row are read-modify-write inside one `BEGIN IMMEDIATE`
transaction: the second writer waits for the first to commit, then reads its
result, so no update is lost.

## Later parts (not in part 1)

Part 2 (deferred to wave 10, decider ruling 7) moves in the state that lives in
loose files today, migrated lazily on read with the old files left readable
for a downgrade:

- issued session and verifier ids, and their tokens (#312);
- live-session markers;
- lease and queue state (#326);
- an index over the per-repo JSONL ledgers, which stay the source of truth,
  and the verdict mirror for throwaway clones (#311).

## Hooks

No hook loads the store in part 1: per-turn hooks must stay fast. The
procs-route slice (wave 9, decider ruling 7) adds `<state>/threads.db*` to the
write gate's guard on `<state>/issued*`, so an agent may not write the files. `test/workit-core/threads-store.test.ts` bundles every hook entry
and fails if one reaches the store or a SQLite module. A later part that wants
a hook to read the store measures the hook's start-up cost first (#329 target:
under 10 ms for open plus one SELECT).

Measured on Linux x64 (Bun 1.4.4, Node 24.20.0) for an existing v1 file: open,
the version read, the WAL pragma and one SELECT by id, then close.

| Runtime | First open in a fresh process (driver load included), median of 9 | Later opens in one process, median of 50 |
| --- | --- | --- |
| Bun | 2.2 ms | 0.24 ms |
| Node (bundled) | 1.6 ms | 0.46 ms |
