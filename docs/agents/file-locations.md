# File locations

Read before adding a file Workit keeps outside a repository, or code that names
one. Every user-level Workit location comes from one resolver,
[`packages/workit-core/src/core/workit-paths.mjs`](../../packages/workit-core/src/core/workit-paths.mjs):
`workitDir(kind, env, platform)` and its `configDir`, `stateDir`, `dataDir`,
`cacheDir` and `runtimeDir` shorthands. TypeScript imports it. The hook launchers
carry byte-equal copies (`workit-claude-code/bin/`, `workit-codex/bin/`,
`workit-cursor/hooks/`), and the POSIX shell launchers embed its `STATE_DIR_SH`,
`CONFIG_DIR_SH` and `DATA_DIR_SH` functions verbatim
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
| config  | `$XDG_CONFIG_HOME/workit`, else `~/.config/workit`         | `%APPDATA%\workit`                         | `WORKIT_CONFIG`, `WORKIT_CONFIG_DIR`, `XDG_CONFIG_HOME` | `workspaces.json` (grants, roles), `config.json`, `vcs.json`, `youtrack.json`, `rules/`. Grants are read only from the default dir under the account home, never an override (D15). | the user, `workit init`, `workit setup`, `workit grant`, `workit upgrade` (update settings)    |
| state   | `$XDG_STATE_HOME/workit`, else `~/.local/state/workit`     | `%LOCALAPPDATA%\workit`                    | `WORKIT_STATE_DIR`, `XDG_STATE_HOME`                | `logs/`, `node.json` (the hook Node), `heavy-commands.json`, `hook-runs/`, `hook-skips.jsonl`, `leases/`, `issued/`, `model-limits.json`, `notices/`, `upgrades/` (config backups), heartbeats         | the CLI, every host's hooks and launchers, `workit setup` and `workit upgrade`               |
| data    | `$XDG_DATA_HOME/workit`, else `~/.local/share/workit`      | `%LOCALAPPDATA%\workit` (install in `install\`) | `WORKIT_INSTALL_ROOT` (the install root), `XDG_DATA_HOME` | the owned CLI install: `versions/`, `current`, `bin/workit`                                                                                                                                   | `workit upgrade --cli`; the dev installers' share clone (`scripts/sync-runtime.sh`)            |
| cache   | `$XDG_CACHE_HOME/workit`, else `~/.cache/workit`           | `%LOCALAPPDATA%\workit\cache`              | `XDG_CACHE_HOME`                                    | reserved: regenerable files. Managed worktrees still sit beside it in `~/.cache/workit-wt` (moving them is a later change)                                                                             | nothing yet                                                                                   |
| runtime | `$XDG_RUNTIME_DIR/workit`, else `$TMPDIR/workit-<uid>`     | `%TEMP%\workit`                            | `XDG_RUNTIME_DIR`                                   | reserved: sockets and locks that die with the session                                                                                                                                                     | nothing yet                                                                                   |

`APPDATA` and `LOCALAPPDATA` fall back to `<profile>\AppData\Roaming` and
`<profile>\AppData\Local` when unset.

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
