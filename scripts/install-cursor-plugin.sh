#!/usr/bin/env bash
# Install / refresh Cursor plugin from this repo or from GitHub.
# Copies into ~/.cursor/plugins/local (real dir — symlinks break IDE discovery)
# and keeps a sync copy at ~/.local/share/workflow-toolkit for MCP + scripts.
set -euo pipefail

REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workflow-toolkit}"
SHARE="${HOME}/.local/share/workflow-toolkit"
PLUGIN_DIR="${HOME}/.cursor/plugins/local/workflow-toolkit"
SKILLS_DIR="${HOME}/.cursor/skills"

# When piped via curl|bash -s, $0 is not a path — force GitHub install.
FROM_GITHUB=0
LOCAL_ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  LOCAL_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
else
  FROM_GITHUB=1
fi

for arg in "$@"; do
  case "$arg" in
    --github|--from-github) FROM_GITHUB=1 ;;
  esac
done

if [ "$FROM_GITHUB" -eq 0 ] && [ ! -d "${LOCAL_ROOT}/cursor/.cursor-plugin" ]; then
  FROM_GITHUB=1
fi

if [ "$FROM_GITHUB" -eq 1 ]; then
  mkdir -p "$(dirname "$SHARE")"
  if [ -d "$SHARE/.git" ]; then
    git -C "$SHARE" fetch --tags --force origin
    git -C "$SHARE" checkout main
    git -C "$SHARE" pull --ff-only origin main
  else
    rm -rf "$SHARE"
    git clone --depth 1 "git@github.com:${REPO_SLUG}.git" "$SHARE"
  fi
  SRC="$SHARE"
else
  SRC="$LOCAL_ROOT"
  mkdir -p "$SHARE"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'cursor/mcp/node_modules' \
    --exclude '.cache' \
    "$SRC/" "$SHARE/"
  SRC="$SHARE"
fi

mkdir -p "${HOME}/.cursor/plugins/local"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
rsync -a --delete \
  --exclude 'mcp/node_modules' \
  "$SRC/cursor/" "$PLUGIN_DIR/"
printf '%s\n' "$SRC" >"$PLUGIN_DIR/.workflow-toolkit-root"

chmod +x \
  "$PLUGIN_DIR/hooks/session-start" \
  "$PLUGIN_DIR/mcp/run-server.sh" \
  "$SRC/scripts/run-cursor-mcp.sh" \
  "$SRC/scripts/install-cursor-plugin.sh" \
  "$SRC/scripts/install-opencode-plugin.sh" 2>/dev/null || true

(cd "$PLUGIN_DIR/mcp" && npm install --silent)

# Drop stale CLI skill symlinks (duplicate /wf-* entries)
if [ -d "$SKILLS_DIR" ]; then
  rm -f "$SKILLS_DIR"/wf-*
fi

python3 - "$PLUGIN_DIR" <<'PY'
import json, os, sys
plugin = sys.argv[1]
path = os.path.expanduser("~/.cursor/settings.json")
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
prev = data.get("enabled_plugins")
if not isinstance(prev, dict):
    prev = {}
data["enabled_plugins"] = {
    **prev,
    "workflow-toolkit": True,
    "local/workflow-toolkit": True,
}
data["plugin_dirs"] = [plugin]
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.cursor/mcp.json")
data = {"mcpServers": {}}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
# Stable share path — works with Cursor install-mcp deeplink too
data.setdefault("mcpServers", {})["workflow-toolkit"] = {
    "command": "bash",
    "args": [
        "-lc",
        'exec "$HOME/.local/share/workflow-toolkit/scripts/run-cursor-mcp.sh" "$0"',
        "${workspaceFolder}",
    ],
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "Share tree:  $SRC"
echo "Cursor plugin: $PLUGIN_DIR"
echo "Fully quit Cursor IDE + Agent CLI, then reopen."
ls "$PLUGIN_DIR/skills" | grep '^wf-' || true
