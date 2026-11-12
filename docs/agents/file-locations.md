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
| config  | `$XDG_CONFIG_HOME/workit`, else `~/.config/workit`         | `%APPDATA%\workit`                         | `WORKIT_CONFIG`, `WORKIT_CONFIG_DIR`, `XDG_CONFIG_HOME` | `workspaces.json` (grants, roles; the hooks' write gate denies an agent's write to it, [configuration](../guides/configuration.md)), `config.json`, `vcs.json`, `youtrack.json`, `rules/`. Grants are read only from the default dir under the account home, never an override (D15); a bench world (`WORKIT_EVAL_WORLD`, [eval.md](eval.md)) counts only where no real workspace matches, and only for its endpoint and lowered grants. | the user, `workit init`, `workit setup`, `workit grant`, `workit upgrade` (update settings)    |
| state   | `$XDG_STATE_HOME/workit`, else `~/.local/state/workit`     | `%LOCALAPPDATA%\workit`                    | `WORKIT_STATE_DIR`, `XDG_STATE_HOME`                | `logs/`, `node.json` (the hook Node), `heavy-commands.json`, `hook-runs/`, `hook-skips.jsonl`, `leases/`, `issued/`, `approvals/` (approval requests and the user's grants, which agents may not write), `model-limits.json`, `notices/`, `ytrack-skill.json` (the ytrack skill dirs Workit installed, so uninstall removes only those), `upgrades/` (config backups), heartbeats, and managed worktrees in `worktrees/<repo>/<slice>` (`<repo>-<hash>` when another checkout with that name already has worktrees there); they hold uncommitted work, so they are state | the CLI, every host's hooks and launchers, `workit setup` and `workit upgrade`               |
| data    | `$XDG_DATA_HOME/workit`, else `~/.local/share/workit`      | `%LOCALAPPDATA%\workit` (install in `install\`) | `WORKIT_INSTALL_ROOT` (the install root), `XDG_DATA_HOME` | the owned CLI install: `versions/`, `current`, `bin/workit`                                                                                                                                   | `workit upgrade --cli`; the dev share-clone installers (`install-*.sh`, via `workit_data_dir`; `install-cursor-plugin.sh` embeds `DATA_DIR_SH` because it runs piped) |
| cache   | `$XDG_CACHE_HOME/workit`, else `~/.cache/workit`           | `%LOCALAPPDATA%\workit\cache`              | `XDG_CACHE_HOME`                                    | reserved: regenerable files. Worktrees from before the move stay in `~/.cache/workit-wt` (never moved; cleanup and `workit gc --worktrees --apply` sweep merged ones and remove the dir once empty; `workit doctor` `legacy_dirs` reports it as info until then) | nothing yet                                                                                   |
| runtime | `$XDG_RUNTIME_DIR/workit`, else `$TMPDIR/workit-<uid>`     | `%TEMP%\workit`                            | `XDG_RUNTIME_DIR`                                   | sockets and locks that die with the session                                                                                                                                                              | the dev `sync-runtime.sh` lock (`sync.lock`), via `workit_runtime_dir` in `scripts/lib/config-dir.sh` |

`APPDATA` and `LOCALAPPDATA` fall back to `<profile>\AppData\Roaming` and
`<profile>\AppData\Local` when unset.

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

When a workspace uses YouTrack, `workit setup` and `workit upgrade` run
`ytrack skill install --dir <root>` for each host with Workit installed, so the
skill matches the installed ytrack. The roots are each host's own user skills
dir (sources in [hosts.md](hosts.md#host-parity)): `~/.claude/skills`
(`CLAUDE_CONFIG_DIR`), `~/.config/opencode/skills` (`XDG_CONFIG_HOME`),
`~/.codex/skills` (`CODEX_HOME`), `~/.cursor/skills`, `~/.pi/agent/skills`
(`PI_CODING_AGENT_DIR`). Only `<root>/ytrack` is written, by ytrack;
`workit uninstall` removes the dirs recorded in `ytrack-skill.json`.

## Repository locations

Per-repo files have two homes. A repo's `.workit/` holds only committed team
config; everything a clone writes for itself lives in the store,
`<git-common-dir>/workit/`, which every worktree of the clone shares and which
`git clean` and worktree removal never touch. Outside git the store is
`<dir>/.workit`. `workit dir <kind>` prints (and for a per-clone kind creates) a
location, so agents never invent one; its user-level kinds print the table above.
[`core/repo-paths.ts`](../../packages/workit-core/src/core/repo-paths.ts) resolves
the per-clone kinds.

| Location                             | Scope                     | What lives there                                                                                    | Written by                                            |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `.workit/`                           | committed, shared by team | `checks.json`, `risk-paths` and future shared config; no `.gitignore`, no runtime files              | the team; `workit doctor --fix` moves a root config in |
| `<git-common-dir>/workit/ledger`     | per clone                 | the shared ledger (`ledger.jsonl`)                                                                  | `workit ledger`, checks, verdicts, hooks              |
| `<git-common-dir>/workit/blobs`      | per clone                 | stored candidates, `workit check` logs (`blobs/logs`)                                               | the task store, `workit check`                        |
| `<git-common-dir>/workit/plans`      | per clone                 | plan files (shape, fanout plan JSON): `workit dir plans`                                             | agents                                                |
| `<git-common-dir>/workit/retros`     | per clone                 | retro reports: `workit dir retros`                                                                  | agents (workit-retro)                                 |
| `<git-common-dir>/workit/handoffs`   | per clone                 | handoff notes too long for `--note`: `workit dir handoffs`                                           | agents (workit-continue)                              |
| `<worktree>/.workit-scratch`         | per worktree              | a fanout slice's temp files (hidden through `info/exclude`)                                        | `workit fanout worktree create`, the slice's worker   |

The store also holds the task store (`tasks/`, `checkouts/`, `store.json`) and
`legacy/<checkout>/v2/`, the backup of what older runtimes left in a checkout's
`.workit/`. Older Workit wrote a self-ignoring `.workit/.gitignore` and
kept a 2.x marker (`workspace.json`) and migrated 2.x task files there. The
store now moves those leftovers into the backup once, on the next write or CLI
call, deleting only exact markers it wrote; `ensureWorkitDir` removes a
generated `.gitignore` (`*`, or `*` with `!risk-paths`) on the next config write
and keeps any other.

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
