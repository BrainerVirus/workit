#!/usr/bin/env bash
# Sync workit runtime for Cursor + OpenCode.
# Prefer local monorepo (dev) when present; otherwise git-pull the share clone.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib/config-dir.sh"

SHARE="${HOME}/.local/share/workflow-toolkit"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/workflow-toolkit"
OPENCODE_PLUGINS="${HOME}/.config/opencode/plugins"
DEV_DEFAULT="${HOME}/Documents/projects/personal/workflow-toolkit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$DEV_DEFAULT}"
REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/workflow-toolkit-sync.lock"

# RR-05: missing required tools, an unacquirable lock, a failed clone, or a failed
# dependency install must never look like a successful sync.
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
  git -C "$SHARE" fetch --quiet origin 2>/dev/null || true
  git -C "$SHARE" pull --ff-only --quiet origin main 2>/dev/null || true
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
# Vendored skills for Cursor (same folder layout as OpenCode registration)
mkdir -p "$PLUGIN_DIR/vendor/superpowers"
if [ -d "$SHARE/packages/workit-core/vendor/superpowers/skills" ]; then
  rsync -a --delete "$SHARE/packages/workit-core/vendor/superpowers/skills" "$PLUGIN_DIR/vendor/superpowers/"
fi
# Canonical user rules -> Cursor .mdc (compiled by the shared core)
CONFIG_RULES_DIR="$(resolve_config_dir)/rules"
if [ -d "$CONFIG_RULES_DIR" ]; then
  "$HOME/.bun/bin/bun" -e "
    import('${SHARE}/packages/workit-core/src/core/rules.ts').then(async ({ writeCompiledCursorRules }) => {
      writeCompiledCursorRules('${PLUGIN_DIR}/rules');
    });
  " >/dev/null 2>&1 || true
fi
printf '%s\n' "$SHARE/packages/workit-core" >"$PLUGIN_DIR/.workflow-toolkit-root"
chmod +x "$PLUGIN_DIR/hooks/session-start" "$PLUGIN_DIR/mcp/run-server.sh" 2>/dev/null || true

if [ ! -d "$PLUGIN_DIR/mcp/node_modules" ]; then
  if ! (cd "$PLUGIN_DIR/mcp" && npm install --silent); then
    echo "FATAL: MCP dependency install failed in $PLUGIN_DIR/mcp" >&2
    exit 1
  fi
fi

# Share MCP also needs deps when launched via run-cursor-mcp fallback
if [ ! -d "$SHARE/packages/workit-cursor/mcp/node_modules" ]; then
  if ! (cd "$SHARE/packages/workit-cursor/mcp" && npm install --silent); then
    echo "FATAL: MCP dependency install failed in $SHARE/packages/workit-cursor/mcp" >&2
    exit 1
  fi
fi

# Remove broken TLA live-loader if present (OpenCode ignored it; /wk-* vanished)
rm -f "${OPENCODE_PLUGINS}/workflow-toolkit.ts"

# Ensure OpenCode has plugin peer dep
PKG="${HOME}/.config/opencode/package.json"
if [ -f "$PKG" ]; then
  PKG_PATH="$PKG" bun -e '
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
