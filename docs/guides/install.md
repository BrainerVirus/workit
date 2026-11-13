# Installing the Workit CLI

The `workit` CLI lives in a directory Workit owns, not in whichever Node's npm global prefix
your shell sees. Switching Node with fnm, nvm, volta, mise or asdf no longer changes which
`workit` runs or which version it is.

## Layout

| Path | What it holds |
| --- | --- |
| `~/.local/share/workit/versions/<version>/` | one `npm install --prefix` tree per installed version |
| `~/.local/share/workit/current` | a link to the version in use, swapped atomically |
| `~/.local/share/workit/bin/workit` | the launcher Workit writes |
| `~/.local/bin/workit` | a link to the launcher: the `workit` PATH finds |

`$XDG_DATA_HOME/workit` replaces `~/.local/share/workit` when set, and `WORKIT_INSTALL_ROOT`
replaces both. `$XDG_BIN_HOME` or `WORKIT_BIN_DIR` replaces `~/.local/bin`. On Windows the root
is `%LOCALAPPDATA%\workit\install`, and the launcher is `workit.cmd` in its `bin` folder.

The launcher runs `current` on a Node 24 or newer, in this order: `WORKIT_NODE`, the node
`workit setup` or `workit upgrade` recorded, the PATH `node` when it is 24+, the newest 24+
under fnm, nvm, volta, mise or asdf, and last the node that installed the version. The hook
launchers use the same order.

## First install

From any shell with Node 24+:

```bash
npx -y @workit-dev/cli@latest upgrade --cli --hosts=none --yes
```

Make sure `~/.local/bin` is on PATH and comes before any version manager's directories. The
upgrade checks this: it fails when `workit --version` from PATH is not the version it just
installed.

## Upgrading

`workit upgrade` installs the new version with a Node 24's own npm
(`node <npm-cli.js> install --prefix <staging>`), moves it into `versions/<version>`, then
swaps `current`. If the run is killed before the swap, `current` still points to the previous
version and the launcher keeps working. The next run clears the half-written staging
directory. Workit keeps the previous version for a manual rollback:

```bash
ln -sfn versions/<previous> ~/.local/share/workit/current
```

After the swap, the upgrade runs `workit --version` the way a new login shell finds it: in
PATH order, without the npx cache directory `npx … upgrade` put first on PATH and without a
host plugin's own launcher. If that prints anything other than the new version, the CLI row
fails, the upgrade exits non-zero and never prints `Verified`, and the row's fix is the one
command that makes PATH's `workit` the launcher: the removal of the copy PATH runs, a move of
a foreign file at `~/.local/bin/workit` into the backup with the launcher link in its place,
or the launcher's directory first on PATH. The row lists every `workit` install in `which -a`
order, then the ones PATH does not reach. The npx cache copy that runs the upgrade is never
listed or removed.

## Installing or repairing a host

`workit install --hosts=cursor --preview` lists the files, config keys, host commands and
notes Workit would write to install Cursor, and changes nothing; `workit install
--hosts=cursor --yes` applies them. It touches the named hosts only: never another host, the
Workit config or a workspace. A host that is already healthy plans nothing, so the command
is safe to run again; a registered host with missing plugin files (an empty
`~/.cursor/plugins/local/workit`, a Claude Code record whose files are gone) is repaired. A
host whose CLI (`claude`, `codex`, `pi`) is not on PATH shows a `blocked` row in the preview,
and the same row when applied, with nothing of that host run. Without `--yes` it asks at a
terminal; from an agent session `--yes` is refused with the command to run yourself.

## Removing a host

`workit uninstall --hosts=cursor --preview` lists the files, config keys and host commands
Workit would remove from Cursor; `workit uninstall --hosts=cursor --yes` removes them and
nothing else (other hosts, your own rules and the Workit config are untouched). Without
`--hosts`, `workit uninstall` opens the interactive picker, which also offers the CLI
install. See [the hosts guide](hosts.md#host-permissions-workit-setup).

## Moving from an npm global install

The first upgrade under this layout looks for other copies: `@workit-dev/cli` in
each fnm, nvm, mise or asdf Node's npm global prefix, a volta package, and a hand-written
wrapper on PATH that runs one (it names a workit-cli package, or execs another `workit` by
path, such as `exec <fnm node> <fnm prefix>/bin/workit "$@"`). Only the script its `exec`
line (or last command) runs counts, and only when that file exists and resolves to a workit-cli
package or the owned launcher; a path in a comment, a `cd` into a `workit` directory or a missing
target leaves the script a foreign file, reported and never moved.

- At a terminal it asks `[y/N]`. On `y`, each copy is copied under
  `~/.local/state/workit/upgrades/<time>/cli-copies/` (with a `manifest.json`) and then
  removed with `npm uninstall --global --prefix <prefix>`, `volta uninstall` or, for a
  wrapper, a move that leaves a link to the launcher in its place. Wrappers go first, so no
  `workit` on PATH runs a copy removed after it; a copy that a wrapper that could not be
  replaced still runs is kept, and the row says why.
- On `N`, in an agent's shell, or with `--json`, nothing is removed. The CLI row prints
  the exact commands that back up and remove each copy.

## Checking

`workit doctor` reports `cli_installs`: every `workit` on PATH and in the version-manager
prefixes, each with its realpath and version. The check fails when an install other than the
launcher comes first on PATH, or when another copy holds a different version. Its fix lists the
removal commands. A host plugin's own launcher, such as the Claude Code plugin's `bin/workit`
on its Bash tool's PATH, is managed by its host: the row names it and never counts it.

## Windows limits

The `workit.cmd` launcher does not scan version managers. It uses `WORKIT_NODE`, then the node
that installed the version, then the PATH `node`. Workit does not edit the Windows PATH: add
`%LOCALAPPDATA%\workit\install\bin` yourself. `current` is a junction. Replacing a junction
takes a remove and a create, so the swap is not atomic on Windows.
