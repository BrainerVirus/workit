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
npx -y @brainervirus/workit-cli@latest upgrade --cli --hosts=none --yes
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

After the swap, the upgrade runs the PATH-resolved `workit --version`. If that prints
anything other than the new version, the CLI row fails and lists every `workit` install in
`which -a` order, then the ones PATH does not reach.

## Moving from an npm global install

The first upgrade under this layout looks for other copies: `@brainervirus/workit-cli` in
each fnm, nvm, mise or asdf Node's npm global prefix, a volta package, and a hand-written
`~/.local/bin/workit` wrapper.

- At a terminal it asks `[y/N]`. On `y`, each copy is copied under
  `~/.local/state/workit/upgrades/<time>/cli-copies/` (with a `manifest.json`) and then
  removed with `npm uninstall --global --prefix <prefix>`, `volta uninstall` or, for a
  wrapper, a move that leaves a link to the launcher in its place.
- On `N`, in an agent's shell, or with `--json`, nothing is removed. The CLI row prints
  the exact commands that back up and remove each copy.

## Checking

`workit doctor` reports `cli_installs`: every `workit` on PATH and in the version-manager
prefixes, each with its realpath and version. The check fails when an install other than the
launcher comes first on PATH, or when another copy holds a different version. Its fix lists the
removal commands.

## Windows limits

The `workit.cmd` launcher does not scan version managers. It uses `WORKIT_NODE`, then the node
that installed the version, then the PATH `node`. Workit does not edit the Windows PATH: add
`%LOCALAPPDATA%\workit\install\bin` yourself. `current` is a junction. Replacing a junction
takes a remove and a create, so the swap is not atomic on Windows.
