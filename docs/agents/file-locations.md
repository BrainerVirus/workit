# File locations

Read before adding a file Workit keeps outside a repository, or code that names
one. Every user-level Workit location comes from one resolver,
[`packages/workit-core/src/core/workit-paths.mjs`](../../packages/workit-core/src/core/workit-paths.mjs):
`workitDir(kind, env, platform)` and its `configDir`, `stateDir`, `dataDir`,
`cacheDir` and `runtimeDir` shorthands. TypeScript imports it. The hook launchers
carry byte-equal copies (`workit-claude-code/bin/`, `workit-codex/bin/`,
`workit-cursor/hooks/`), and the POSIX shell launchers embed its `STATE_DIR_SH`,
`CONFIG_DIR_SH`, `DATA_DIR_SH` and `RUNTIME_DIR_SH` functions verbatim
(`workit-claude-code/bin/workit`, the owned launcher `workit upgrade` writes,
`workit-core/scripts/lib/config-dir.sh`). `test/workit-core/workit-paths.test.ts`
holds the copies equal and runs the shell functions against the JavaScript;
`test/workit-core/file-locations-lint.test.ts` fails when other code builds a
Workit location from `homedir()`, an `XDG_*` variable, `APPDATA`,
`LOCALAPPDATA` or `Library/Application Support`.

Linux and macOS follow the
[XDG Base Directory spec](https://specifications.freedesktop.org/basedir-spec/latest/).
An absolute `XDG_*` variable wins on every platform; a relative one is ignored,
as the spec says. A `WORKIT_*` override names the directory itself and wins over
everything.

## Locations

| Kind    | Linux and macOS                                            | Windows                                    | Env override (first wins)                           | What lives there                                                                                                                                                                                          | Written by                                                                                    |
| ------- | ---------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| config  | `$XDG_CONFIG_HOME/workit`, else `~/.config/workit`         | `%APPDATA%\workit`                         | `WORKIT_CONFIG`, `WORKIT_CONFIG_DIR`, `XDG_CONFIG_HOME` | `workspaces.json` (grants, roles; the hooks' write gate denies an agent's write to it, and so do the native deny rules `workit setup` writes on Claude Code, Cursor and OpenCode, [configuration](../guides/configuration.md)), `workspaces.json.seal` (the authority fields the user last accepted with `workit workspace seal`; account dir only, [grants](../guides/grants.md#the-seal)), `config.json`, `vcs.json`, `youtrack.json`, `rules/`, `templates/`. Grants, the endpoint, verification, remote caps, `youtrack.writes: auto` and `youtrack.autoHosts` are read only from the default dir under the account home (a redirect only lowers them to the defaults), which comes from the OS account record on every runtime and never from `HOME`, `USERPROFILE` or an override (D15, `core/account-home.ts`); a bench world (`WORKIT_EVAL_WORLD`, [eval.md](eval.md)) shows and writes grants in its own `config/` dir and counts only where no real workspace matches, and only for its endpoint and lowered grants. A bench run gets a world `HOME`, so none of these resolve to yours ([isolation](eval.md#isolation-and-the-tripwire)). | the user, `workit init`, `workit setup`, `workit grant`, `workit workspace` (`seal`: the user's terminal only), `workit upgrade` (update settings, the first-seal offer)    |
| state   | `$XDG_STATE_HOME/workit`, else `~/.local/state/workit`     | `%LOCALAPPDATA%\workit`                    | `WORKIT_STATE_DIR`, `XDG_STATE_HOME`                | `logs/`, `node.json` (the hook Node), `heavy-commands.json`, `hook-runs/`, `hook-skips.jsonl`, `leases/`, `issued/`, `issued-tokens/` (token hashes of issued subagent ids), `live-sessions/` (one live-session marker per checkout), `worktree-bind/` (the worktree each implementer is bound to), `agent-stamps/` (one empty file per `workit` call a Claude Code or Codex hook let through, naming the calling subagent, or none for the lead, for the CLI to claim, kept 2 minutes, #883; a check row records whether a claimed stamp named its agent, `agentFrom`, and on those hosts only such rows hold a verdict, #972), `stale-plugin/` (Claude Code's once-per-session stale-plugin markers), `verdicts/` (a per-remote mirror of recorded verdicts, and `verdicts/sets/` the set verdicts every repository's merge gate reads, #891), `host-permissions.json` (what setup wrote into host settings) and `host-permissions-backup/`, `approvals/` (approval requests and the user's grants, which agents may not write), `threads.db` (with its `-wal` and `-shm` files: the per-user SQLite store, mode 0600; no hook opens it yet; [threads spec](../specs/threads.md)), `procs/` (the process registry's files: `logs/<id>.log` each background process's output, `notices/<session>.json` the RSS ceiling notices for one owner session, `rows/<id>.json` per-row facts the `procs` table has no column for and `rows/<id>.stop` a stop request its supervisor polls for; `teardown.log` the session-end teardown's log and `reap-at-start.stamp` (with its `.claim`) the once-per-10-minutes reap stamp; [background processes](../guides/processes.md)), `model-limits.json`, `notices/`, `last-failure/<session>.json` (each session's last failing verb and its output, mode 0600, for `workit feedback`), `ytrack-skill.json` (the ytrack skill dirs an older Workit installed, until `workit upgrade` retires them), `upgrades/` (config backups), heartbeats, managed worktrees in `worktrees/<repo>/<slice>` (`<repo>-<hash>` when another checkout with that name already has worktrees there); they hold uncommitted work, so they are state; the task store of each folder outside git in `folders/<folder>-<hash>` (ledger, tasks, plans, retros, handoffs, notes: what `<git-common-dir>/workit/` holds for a clone), and each fanout worker's scratch dir in `scratch/<repo>/<slice>` (the same `<repo>` dir name, mode 0700, outside every working tree; race attempts use `<slice>+try<n>` beside it; they go with the slice's worktree on `fanout worktree release`, `workit gc --worktrees --apply` and the cleanup after a merge) | the CLI (`workit run --bg` and its supervisor write `procs/`), every host's hooks and launchers, `workit setup` and `workit upgrade`               |
| data    | `$XDG_DATA_HOME/workit`, else `~/.local/share/workit`      | `%LOCALAPPDATA%\workit` (install in `install\`) | `WORKIT_INSTALL_ROOT` (the install root), `XDG_DATA_HOME` | the owned CLI install: `versions/`, `current`, `bin/workit`                                                                                                                                   | `workit upgrade --cli`; the dev share-clone installers (`install-*.sh`, via `workit_data_dir`; `install-cursor-plugin.sh` embeds `DATA_DIR_SH` because it runs piped) |
| cache   | `$XDG_CACHE_HOME/workit`, else `~/.cache/workit`           | `%LOCALAPPDATA%\workit\cache`              | `XDG_CACHE_HOME`                                    | reserved: regenerable files. Worktrees from before the move stay in `~/.cache/workit-wt` (never moved; cleanup and `workit gc --worktrees --apply` sweep merged ones and remove the dir once empty; `workit doctor` `legacy_dirs` reports it as info until then) | nothing yet                                                                                   |
| runtime | `$XDG_RUNTIME_DIR/workit`, else `$TMPDIR/workit-<uid>`     | `%TEMP%\workit`                            | `XDG_RUNTIME_DIR`                                   | sockets and locks that die with the session                                                                                                                                                              | the dev `sync-runtime.sh` lock (`sync.lock`), via `workit_runtime_dir` in `scripts/lib/config-dir.sh` |

`APPDATA` and `LOCALAPPDATA` fall back to `<profile>\AppData\Roaming` and
`<profile>\AppData\Local` when unset.

### The account home (grants)

Grants, and the user's own ssh and git config that the remote checks trust,
are read under the account home (`packages/workit-core/src/core/account-home.ts`),
which no variable a caller sets moves:

| Runtime | Linux | macOS | Windows |
| --- | --- | --- | --- |
| node | `os.userInfo()` (`getpwuid_r`) | `os.userInfo()` (`getpwuid_r`) | `os.userInfo()` (the process token's profile dir) |
| bun | the `/etc/passwd` line of the uid (`#` lines skipped), else `/usr/bin/getent passwd <uid>` | the `/etc/passwd` line of the uid, else `/usr/bin/id -P` | `C:\Windows\System32\whoami.exe /user` for the SID, then `reg.exe query` of its `ProfileList` `ProfileImagePath` |

Bun's `os.userInfo()` follows `HOME` (`USERPROFILE` on Windows), so bun uses
the record directly. An account absent from `/etc/passwd` (LDAP, NIS, sssd)
goes through `getent`, with a 3 s timeout. Each program runs by absolute path
with a fixed env (none, or `SystemRoot` on Windows) and no shell. On Windows
only `%SystemDrive%` and `%SystemRoot%` in `ProfileImagePath` are expanded,
from `C:\Windows`; any other variable fails closed. When no record answers
there is no account home: no grants are read (the D4 defaults apply), `grant
set` refuses, and no fallback path is built. The bench's isolation self-check
judges the `workit` first on the run's `PATH` ([eval.md](eval.md#isolation-and-the-tripwire)).

### Shell completion files

`workit setup` and `workit upgrade` write the completion script for `$SHELL`
where that shell loads per-user completions; `workit uninstall` removes them.
[`packages/workit-cli/src/completion/install.ts`](../../packages/workit-cli/src/completion/install.ts)
derives each path from `workitDir` (the parent of Workit's data or config dir),
so Workit's own `WORKIT_CONFIG*` overrides never move them. Each file starts with
a `# workit-owned-completion` line; a file without it is never overwritten or
removed. No rc file is edited.

| Shell      | Linux and macOS                                                                              |
| ---------- | -------------------------------------------------------------------------------------------- |
| zsh        | `$XDG_DATA_HOME/zsh/site-functions/_workit`, else `~/.local/share/zsh/site-functions/_workit` |
| bash       | `$XDG_DATA_HOME/bash-completion/completions/workit`, else `~/.local/share/bash-completion/completions/workit` |
| fish       | `$XDG_CONFIG_HOME/fish/completions/workit.fish`, else `~/.config/fish/completions/workit.fish` |
| PowerShell | none: setup prints the `$PROFILE` line (`workit completion powershell \| Out-String \| Invoke-Expression`) |

### Agent skill dirs (ytrack)

ytrack 0.6.0 and newer installs and refreshes its own agent skill
(`~/.agents/skills/ytrack`, `~/.claude/skills/ytrack`); Workit writes none.
An older Workit installed `<root>/ytrack` into each host's own user skills dir
(sources in [hosts.md](hosts.md#host-parity)) and recorded them in
`ytrack-skill.json`. Once `~/.agents/skills/ytrack` exists, `workit upgrade`
removes the recorded Codex, Cursor, OpenCode and Pi copies and deletes the
record; `workit uninstall` removes recorded dirs that are left, never
`~/.claude/skills/ytrack` while ytrack keeps its skill.

## Repository locations

Workit never asks a repository to ignore anything: no Workit file it or an
agent writes lands in a working tree where Prettier, ESLint or Jest would scan
it, so no Workit name has to enter a shared repo's `.gitignore`,
`.prettierignore` or tool config (#742).

Per-repo files have two homes. A repo's `.workit/` holds only committed team
config; everything a clone writes for itself lives in the store,
`<git-common-dir>/workit/`, which every worktree of the clone shares and which
`git clean` and worktree removal never touch. Outside git the store is
`<state>/folders/<folder>-<hash>` (`folderStoreDir` in `workit-paths.mjs`,
keyed like a checkout by the folder's canonical path), never in the folder:
a non-git parent, a home folder or a synced folder gets no Workit file (#892).
`workit dir <kind>` prints (and for a per-clone kind creates) a
location, so agents never invent one; its user-level kinds print the table above.
[`core/repo-paths.ts`](../../packages/workit-core/src/core/repo-paths.ts) resolves
the per-clone kinds.

| Location                             | Scope                     | What lives there                                                                                    | Written by                                            |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `.workit/`                           | committed, shared by team | `checks.json`, `risk-paths` and future shared config; no `.gitignore`, no runtime files              | the team; `workit doctor --fix` moves a root config in |
| `<git-common-dir>/workit/ledger`     | per clone                 | the shared ledger (`ledger.jsonl`)                                                                  | `workit ledger`, checks, verdicts, hooks              |
| `<git-common-dir>/workit/blobs`      | per clone                 | stored candidates, `workit check` logs (`blobs/logs`)                                               | the task store, `workit check`                        |
| `<git-common-dir>/workit/plans`      | per clone                 | plan files (shape, fanout plan JSON, the one-slice plan an ad-hoc `fanout worktree create <slice>` writes): `workit dir plans` | agents, `workit fanout worktree create` |
| `<git-common-dir>/workit/retros`     | per clone                 | retro reports and unposted `workit feedback` drafts (mode 0600): `workit dir retros` | agents (workit-retro), `workit feedback` |
| `<git-common-dir>/workit/handoffs`   | per clone                 | handoff notes too long for `--note`: `workit dir handoffs`                                           | agents (workit-continue)                              |
| `<git-common-dir>/workit/notes`      | per clone                 | an agent's or user's notes, never in `.workit/`: `workit dir notes`                                 | agents, the user; `workit doctor --fix` moves untracked `.workit/` files here |
| `<worktree>/.workit-scratch`         | per worktree              | a verifier's or reviewer's probes in the candidate worktree (hidden through `info/exclude`); a worker's scratch is `<state>/scratch/<repo>/<slice>` | the judge agents                                      |

The store also holds the task store (`tasks/`, `checkouts/`, `store.json`) and
`legacy/<checkout>/v2/`, the backup of what older runtimes left in a checkout's
`.workit/`. Older Workit wrote a self-ignoring `.workit/.gitignore` and
kept a 2.x marker (`workspace.json`) and migrated 2.x task files there. The
store now moves those leftovers into the backup once, on the next write or CLI
call, deleting only exact markers it wrote; `ensureWorkitDir` removes a
generated `.gitignore` (`*`, or `*` with `!risk-paths`) on the next config write
and keeps any other.

`workit doctor` row `workit_notes` warns when a checkout's `.workit/` holds
untracked files other than team config (`checks.json`, `risk-paths`; a
`.gitignore` and the old store files the task store moves into its own
`legacy/` backup, such as `ledger/`, `tasks/` or `metadata.lock`, are left
alone too), with their count. `workit doctor --fix` moves
each into `workit dir notes` at the same relative path, prints each move, never
overwrites (a taken name gets `-2`, `-3`, … before its extension), never
touches a tracked file or team config, removes the `.workit/` dirs it emptied,
and does nothing outside git. A second run finds nothing to move.

### A `.workit/` outside git

Older Workit kept a non-git folder's store in `<folder>/.workit` (`store.json`,
`ledger/`, `checkouts/`, `tasks/`, `keys/`, `hooks/`, and any plans or retros
written there). The first Workit call that resolves the store for that folder
(any CLI verb, hook or `workit dir`) moves it into `<state>/folders/<folder>-<hash>`
once ([`store/folder-store.ts`](../../packages/workit-core/src/store/folder-store.ts))
and prints one line naming both paths. It never replaces an entry the new
store already has: those stay, beside a `MOVED-TO-STATE.txt` naming the new
store and the merge command. The folder's own config (`checks.json`,
`risk-paths`) stays, and so do what a 2.x migration left for 2.x readers
(`recovery/`, `tasks/<id>.json` stubs and the `workspace.json` marker); the
marker and a generated `.gitignore` go once nothing else is left. A second run
finds nothing to move.

`workit doctor` row `stray_workit` warns about each `.workit/` holding Workit
state in the cwd or a parent that is not inside a repository, with the command
that moves it (`workit --cwd <folder> dir notes`). A `.workit/` holding only
`checks.json` or `risk-paths`, or one inside a repository, is not listed.

## Not Workit locations

The lint test allowlists these: they are other tools' files, which Workit reads
or writes where those tools keep them.

- Node version managers (fnm, nvm, volta, mise, asdf), including
  `~/Library/Application Support/fnm`: `node-resolve.mjs` and the shell launchers
  scan them for a Node 24.
- Host files: `~/.claude`, `~/.codex`, `~/.cursor`, `~/.pi`,
  `$XDG_CONFIG_HOME/opencode`, the OpenCode cache, Claude Code's managed settings.
- `~/.ssh/config`, `gh` and `glab` config dirs, `~` in a shell command, the
  systemd user runtime dir, the user's `bin` dir on PATH (`XDG_BIN_HOME`,
  `~/.local/bin`) and sandbox environments a probe hands a child process.

## Migration from older locations

Before this resolver, macOS kept state in `~/Library/Application Support/workit`
and Windows kept config in `~\.config\workit`. The first CLI run or hook run
(`migrateLegacyDirs`) moves such a directory to its new place when the new one
does not exist yet and no override or `XDG_*` variable is set for that kind. It
leaves `<old dir>.moved-<UTC stamp>` beside the old place, naming the new one,
and the CLI logs one line in the new state dir. A second run finds nothing to
move.

`workit doctor` row `legacy_dirs` reports the result: `info` after a move,
`warn` when an old directory is left beside an existing new one, with the exact
command that merges it (`cp -Rn <old>/. <new>/ && mv <old> <old>.moved-<stamp>`;
`robocopy … /E /XC /XN /XO; Rename-Item …` on Windows).

| Old location (until this change)        | New location             | Platform |
| --------------------------------------- | ------------------------ | -------- |
| `~/Library/Application Support/workit`  | `~/.local/state/workit`  | macOS    |
| `~\.config\workit`                      | `%APPDATA%\workit`       | Windows  |
