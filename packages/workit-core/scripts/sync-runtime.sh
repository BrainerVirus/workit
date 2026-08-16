#!/usr/bin/env bash
# Sync workit runtime for Cursor + OpenCode.
# Prefer local monorepo (dev) when present; otherwise git-pull the share clone.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib/config-dir.sh"

SHARE="${HOME}/.local/share/workit"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/workit"
OPENCODE_PLUGINS="${HOME}/.config/opencode/plugins"
DEV_DEFAULT="${HOME}/Documents/projects/personal/workflow-toolkit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$DEV_DEFAULT}"
REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/workflow-toolkit-sync.lock"

# RR-05: missing required tools, an unacquirable lock, or a failed clone must
# never look like a successful sync.
if ! command -v flock >/dev/null 2>&1; then
  echo "FATAL: sync-runtime requires flock (util-linux) — not found in PATH" >&2
  exit 1
fi
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

for DEP in @brainervirus/workit-core @modelcontextprotocol/sdk zod; do
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

if ! (cd "$SRC" && PATH="$(dirname "$BUN_BIN"):$PATH" "$BUN_BIN" "$CURSOR_SRC/scripts/build.ts"); then
  echo "FATAL: Cursor adapter build failed in $CURSOR_SRC" >&2
  exit 1
fi
for ENTRY in mcp-server.js cursor-session-start.js; do
  DIST_ENTRY="$CURSOR_SRC/dist/$ENTRY"
  if [ ! -f "$DIST_ENTRY" ] || [ ! -s "$DIST_ENTRY" ] || [ "$(IFS= read -r LINE <"$DIST_ENTRY"; printf '%s' "$LINE")" != '#!/usr/bin/env node' ]; then
    echo "FATAL: Cursor adapter invalid dist entry: $DIST_ENTRY" >&2
    exit 1
  fi
done

if [ "$SRC" != "$SHARE" ]; then
  mkdir -p "$SHARE"
  # Keep .git if share is a clone; never wipe it when syncing from the monorepo
  rsync -a --delete \
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
  "$BUN_BIN" -e "
    import('${SHARE}/packages/workit-core/src/core/rules.ts').then(async ({ writeCompiledCursorRules }) => {
      writeCompiledCursorRules('${PLUGIN_DIR}/rules');
    });
  " >/dev/null 2>&1 || true
fi
printf '%s\n' "$SHARE/packages/workit-core" >"$PLUGIN_DIR/.workit-root"

# CA-08/CA-09: migrate the legacy local plugin identity to `workit` only after
# the canonical sync succeeded; carry the legacy user rules forward first.
LEGACY_DIR="${HOME}/.cursor/plugins/local/workflow-toolkit"
if [ -d "$LEGACY_DIR" ] && [ "$LEGACY_DIR" != "$PLUGIN_DIR" ]; then
  if [ -d "$LEGACY_DIR/rules" ]; then
    mkdir -p "$PLUGIN_DIR/rules"
    for rule in "$LEGACY_DIR"/rules/*.mdc; do
      [ -e "$rule" ] || continue
      [ -e "$PLUGIN_DIR/rules/$(basename "$rule")" ] || cp "$rule" "$PLUGIN_DIR/rules/"
    done
  fi
  rm -rf "$LEGACY_DIR"
fi

# Remove broken TLA live-loader if present (OpenCode ignored it; /wk-* vanished)
rm -f "${OPENCODE_PLUGINS}/workflow-toolkit.ts"

# Ensure OpenCode has plugin peer dep
PKG="${HOME}/.config/opencode/package.json"
if [ -f "$PKG" ]; then
  PKG_PATH="$PKG" "$BUN_BIN" -e '
import fs from "node:fs";
const path = process.env.PKG_PATH!;
const data = JSON.parse(fs.readFileSync(path, "utf8"));
data.dependencies = data.dependencies ?? {};
data.dependencies["@opencode-ai/plugin"] = data.dependencies["@opencode-ai/plugin"] ?? "1.17.7";
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' || true
fi

# Drop bun package cache so old github/file installs cannot shadow file:// plugin.ts
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

exit 0
