#!/usr/bin/env bash
# Sync workit runtime for Cursor + OpenCode.
# Prefer local monorepo (dev) when present; otherwise git-pull the share clone.
set -euo pipefail

SHARE="${HOME}/.local/share/workflow-toolkit"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/workflow-toolkit"
OPENCODE_PLUGINS="${HOME}/.config/opencode/plugins"
DEV_DEFAULT="${HOME}/Documents/projects/personal/workflow-toolkit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$DEV_DEFAULT}"
REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workflow-toolkit}"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/workflow-toolkit-sync.lock"

exec 9>"$LOCK"
if ! flock -n 9; then
  exit 0
fi

SRC=""
if [ -f "${DEV}/packages/workit/src/plugin.ts" ] && [ -d "${DEV}/packages/workit/cursor/.cursor-plugin" ]; then
  SRC="$DEV"
elif [ -d "${SHARE}/.git" ]; then
  git -C "$SHARE" fetch --quiet origin 2>/dev/null || true
  git -C "$SHARE" pull --ff-only --quiet origin main 2>/dev/null || true
  SRC="$SHARE"
elif [ ! -d "${SHARE}/packages/workit/src" ]; then
  mkdir -p "$(dirname "$SHARE")"
  git clone --depth 1 "git@github.com:${REPO_SLUG}.git" "$SHARE" 2>/dev/null || exit 0
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
  "$SHARE/packages/workit/cursor/" "$PLUGIN_DIR/"
# Vendored skills for Cursor (same folder layout as OpenCode registration)
mkdir -p "$PLUGIN_DIR/vendor/superpowers"
if [ -d "$SHARE/packages/workit/vendor/superpowers/skills" ]; then
  rsync -a --delete "$SHARE/packages/workit/vendor/superpowers/skills" "$PLUGIN_DIR/vendor/superpowers/"
fi
# Canonical user rules -> Cursor .mdc (compiled by the shared core)
CONFIG_RULES_DIR="${HOME}/.config/workflow-toolkit/rules"
if [ -d "$CONFIG_RULES_DIR" ]; then
  "$HOME/.bun/bin/bun" -e "
    import('${SHARE}/packages/workit/src/core/rules.ts').then(async ({ writeCompiledCursorRules }) => {
      writeCompiledCursorRules('${PLUGIN_DIR}/rules');
    });
  " >/dev/null 2>&1 || true
fi
printf '%s\n' "$SHARE/packages/workit" >"$PLUGIN_DIR/.workflow-toolkit-root"
chmod +x "$PLUGIN_DIR/hooks/session-start" "$PLUGIN_DIR/mcp/run-server.sh" 2>/dev/null || true

if [ ! -d "$PLUGIN_DIR/mcp/node_modules" ]; then
  (cd "$PLUGIN_DIR/mcp" && npm install --silent) || true
fi

# Share MCP also needs deps when launched via run-cursor-mcp fallback
if [ ! -d "$SHARE/packages/workit/cursor/mcp/node_modules" ]; then
  (cd "$SHARE/packages/workit/cursor/mcp" && npm install --silent) || true
fi

# Remove broken TLA live-loader if present (OpenCode ignored it; /wf-* vanished)
rm -f "${OPENCODE_PLUGINS}/workflow-toolkit.ts"

# Ensure OpenCode has plugin peer dep
PKG="${HOME}/.config/opencode/package.json"
if [ -f "$PKG" ]; then
  python3 - "$PKG" <<'PY' || true
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
deps = data.setdefault("dependencies", {})
deps.setdefault("@opencode-ai/plugin", "1.17.7")
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
fi

# Drop bun package cache so old github/file installs cannot shadow file:// plugin.ts
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

exit 0
