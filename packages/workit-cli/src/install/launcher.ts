// The launcher PATH finds as `workit`: it picks a Node >= 24 in the same order
// as core/node-resolve.mjs (WORKIT_NODE, the node `workit setup`/`upgrade`
// recorded, then the version-manager installs), never just whichever Node the
// shell's version manager put first, and runs <install root>/current.
import { LAUNCHER_MARKER, entryOf } from "./paths";

const FLOOR_MAJOR = 24;

const shSingle = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The POSIX launcher. Order: $WORKIT_NODE; the recorded node.json (its
 * version >= 24); the PATH `node` when it is >= 24; the highest >= 24 under
 * fnm, nvm, volta, mise or asdf; last, the node that installed this version.
 */
export const launcherScript = (options: {
  root: string;
  installNode: string;
  platform?: NodeJS.Platform;
}): string => {
  const stateSuffix =
    (options.platform ?? process.platform) === "darwin"
      ? "Library/Application Support/workit"
      : ".local/state/workit";
  return `#!/bin/sh
# ${LAUNCHER_MARKER} 1: written by \`workit upgrade\`; runs the Workit-owned install.
root=${shSingle(options.root)}
entry=${shSingle(entryOf(`${options.root}/current`))}
if [ ! -f "$entry" ]; then
  echo "workit: no current install under $root; reinstall with: npx -y @brainervirus/workit-cli@latest upgrade --cli --hosts=none --yes" >&2
  exit 127
fi
vnum() {
  _v=\${1#v}
  case $_v in ''|[!0-9]*) echo 0; return;; esac
  _a=\${_v%%.*}; _r=\${_v#"$_a"}; _r=\${_r#.}
  _b=\${_r%%.*}; _c=\${_r#"$_b"}; _c=\${_c#.}; _c=\${_c%%[!0-9]*}
  case $_a in *[!0-9]*) echo 0; return;; esac
  case $_b in ''|*[!0-9]*) _b=0;; esac
  echo $(( _a * 1000000 + _b * 1000 + \${_c:-0} ))
}
ok() { [ "$(vnum "$1")" -ge ${FLOOR_MAJOR * 1000000} ]; }
pick=
if [ -n "\${WORKIT_NODE:-}" ] && [ -x "$WORKIT_NODE" ]; then pick=$WORKIT_NODE; fi
if [ -z "$pick" ]; then
  state=\${WORKFLOW_TOOLKIT_STATE:-}
  if [ -z "$state" ] && [ -n "\${XDG_STATE_HOME:-}" ]; then state=$XDG_STATE_HOME/workit; fi
  if [ -z "$state" ]; then state="$HOME/${stateSuffix}"; fi
  if [ -f "$state/node.json" ]; then
    p=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$state/node.json" | head -n 1)
    v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$state/node.json" | head -n 1)
    if [ -n "$p" ] && [ -x "$p" ] && ok "$v"; then pick=$p; fi
  fi
fi
if [ -z "$pick" ] && command -v node >/dev/null 2>&1; then
  if ok "$(node --version 2>/dev/null)"; then pick=$(command -v node); fi
fi
if [ -z "$pick" ]; then
  best=0
  for n in "\${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \\
    "\${XDG_DATA_HOME:-$HOME/.local/share}"/fnm/node-versions/*/installation/bin/node \\
    "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin/node \\
    "$HOME/.fnm"/node-versions/*/installation/bin/node \\
    "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \\
    "\${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node \\
    "\${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/node/*/bin/node \\
    "\${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node; do
    [ -x "$n" ] || continue
    d=\${n%/bin/node}; d=\${d%/installation}; v=$(vnum "\${d##*/}")
    if [ "$v" -ge ${FLOOR_MAJOR * 1000000} ] && [ "$v" -gt "$best" ]; then best=$v; pick=$n; fi
  done
fi
if [ -z "$pick" ] && [ -x ${shSingle(options.installNode)} ]; then pick=${shSingle(options.installNode)}; fi
if [ -z "$pick" ]; then
  echo "workit: needs Node ${FLOOR_MAJOR}+ and found none (install one: fnm install ${FLOOR_MAJOR}), or set WORKIT_NODE" >&2
  exit 127
fi
exec "$pick" "$entry" "$@"
`;
};

/**
 * The Windows launcher (a .cmd: no version-manager scan in batch). Order:
 * %WORKIT_NODE%, the node that installed this version, then the PATH `node`.
 */
export const launcherCmd = (options: { root: string; installNode: string }): string =>
  [
    "@echo off",
    `rem ${LAUNCHER_MARKER} 1: written by workit upgrade; runs the Workit-owned install.`,
    "setlocal",
    `set "WORKIT_ENTRY=${entryOf(`${options.root}\\current`).replaceAll("/", "\\")}"`,
    'set "WORKIT_PICK="',
    'if defined WORKIT_NODE if exist "%WORKIT_NODE%" set "WORKIT_PICK=%WORKIT_NODE%"',
    `if not defined WORKIT_PICK if exist "${options.installNode}" set "WORKIT_PICK=${options.installNode}"`,
    'if not defined WORKIT_PICK set "WORKIT_PICK=node"',
    '"%WORKIT_PICK%" "%WORKIT_ENTRY%" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
