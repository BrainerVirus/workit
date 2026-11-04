#!/usr/bin/env bash
# Sync workit runtime for Cursor + OpenCode.
# Prefer local monorepo (dev) when present; otherwise git-pull the share clone.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib/config-dir.sh"

SHARE="$(workit_data_dir)"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/workit"
DEV_DEFAULT="${HOME}/Documents/projects/personal/workit"
DEV="${WORKIT_DEV:-$DEV_DEFAULT}"
REPO_SLUG="${WORKIT_REPO:-BrainerVirus/workit}"
LOCK_DIR="$(workit_runtime_dir)"
LOCK="$LOCK_DIR/sync.lock"

# RR-05: missing required tools, an unacquirable lock, or a failed clone must
# never look like a successful sync.
if ! command -v flock >/dev/null 2>&1; then
  echo "FATAL: sync-runtime requires flock (util-linux) — not found in PATH" >&2
  exit 1
fi
mkdir -p "$LOCK_DIR"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "sync-runtime: another process holds $LOCK — state unverified, failing" >&2
  exit 1
fi

SRC=""
if [ -f "${DEV}/packages/workit-opencode/src/plugin.ts" ] && [ -d "${DEV}/packages/workit-cursor/.cursor-plugin" ]; then
  SRC="$DEV"
elif [ -d "${SHARE}/.git" ]; then
  # RR-05: a failed update of an existing share clone must not look like a
  # successful sync — propagate fetch/pull failures to a FATAL nonzero exit.
  if ! git -C "$SHARE" fetch --quiet origin; then
    echo "FATAL: could not fetch updates for $SHARE" >&2
    exit 1
  fi
  if ! git -C "$SHARE" pull --ff-only --quiet origin main; then
    echo "FATAL: could not update $SHARE from origin/main" >&2
    exit 1
  fi
  SRC="$SHARE"
elif [ ! -d "${SHARE}/packages/workit-core/src" ]; then
  mkdir -p "$(dirname "$SHARE")"
  if ! git clone --depth 1 "https://github.com/${REPO_SLUG}.git" "$SHARE"; then
    echo "FATAL: could not clone https://github.com/${REPO_SLUG}.git into $SHARE" >&2
    exit 1
  fi
  SRC="$SHARE"
else
  SRC="$SHARE"
fi

CURSOR_SRC="$SRC/packages/workit-cursor"
BUN_BIN=""
if [ -n "${BUN:-}" ]; then
  BUN_BIN="$BUN"
  if [ ! -x "$BUN_BIN" ]; then
    echo "FATAL: BUN is set but unusable: $BUN_BIN" >&2
    exit 1
  fi
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  echo "FATAL: Bun is required to build the Cursor adapter" >&2
  exit 1
fi

for DEP in @brainervirus/workit-core @brainervirus/workit-mcp @modelcontextprotocol/sdk zod; do
  if [ ! -e "$SRC/node_modules/$DEP" ]; then
    if [ ! -f "$SRC/bun.lock" ]; then
      echo "FATAL: dependency install requires $SRC/bun.lock" >&2
      exit 1
    fi
    if ! (cd "$SRC" && "$BUN_BIN" install --frozen-lockfile); then
      echo "FATAL: root dependency install failed in $SRC" >&2
      exit 1
    fi
    break
  fi
done

if ! (cd "$SRC" && PATH="$(dirname "$BUN_BIN"):$PATH" "$BUN_BIN" "$SRC/packages/workit-mcp/scripts/build.ts"); then
  echo "FATAL: shared MCP build failed in $SRC" >&2
  exit 1
fi
if ! (cd "$SRC" && PATH="$(dirname "$BUN_BIN"):$PATH" "$BUN_BIN" "$CURSOR_SRC/scripts/build.ts"); then
  echo "FATAL: Cursor adapter build failed in $CURSOR_SRC" >&2
  exit 1
fi
for ENTRY in mcp-server.js cursor-session-start.js workit-hook.js; do
  DIST_ENTRY="$CURSOR_SRC/dist/$ENTRY"
  if [ ! -f "$DIST_ENTRY" ] || [ ! -s "$DIST_ENTRY" ] || [ "$(IFS= read -r LINE <"$DIST_ENTRY"; printf '%s' "$LINE")" != '#!/usr/bin/env node' ]; then
    echo "FATAL: Cursor adapter invalid dist entry: $DIST_ENTRY" >&2
    exit 1
  fi
done

if [ "$SRC" != "$SHARE" ]; then
  mkdir -p "$SHARE"
  # Keep .git if share is a clone; never wipe it when syncing from the monorepo
  # versions/, current and bin/ are the owned CLI install (workit upgrade): never delete them
  rsync -a --delete \
    --exclude '/versions' --exclude '/current' --exclude '/bin' \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'cursor/mcp/node_modules' \
    --exclude '.cache' \
    "$SRC/" "$SHARE/"
fi

# Cursor IDE package (real directory)
mkdir -p "${HOME}/.cursor/plugins/local"
mkdir -p "$PLUGIN_DIR"
rsync -a --delete \
  --exclude 'mcp/node_modules' \
  "$SHARE/packages/workit-cursor/" "$PLUGIN_DIR/"

if ! "$BUN_BIN" "$SHARE/packages/workit-core/src/core/skill-manifests.ts" "$PLUGIN_DIR"; then
  echo "FATAL: Cursor skill validation failed: $PLUGIN_DIR" >&2
  exit 1
fi
# Canonical user rules -> Cursor .mdc (compiled by the shared core)
CONFIG_RULES_DIR="$(resolve_config_dir)/rules"
if [ -d "$CONFIG_RULES_DIR" ]; then
  # rules.ts is loaded only here (scripts/check-reachability.ts allowlists it):
  # a failure must surface, never leave the Cursor rules silently stale.
  if ! "$BUN_BIN" -e "
    const { writeCompiledCursorRules } = await import('${SHARE}/packages/workit-core/src/core/rules.ts');
    writeCompiledCursorRules('${PLUGIN_DIR}/rules');
  " >/dev/null; then
    echo "FATAL: Cursor rule compilation failed: $CONFIG_RULES_DIR -> $PLUGIN_DIR/rules" >&2
    exit 1
  fi
fi
printf '%s\n' "$SHARE/packages/workit-core" >"$PLUGIN_DIR/.workit-root"

exit 0
