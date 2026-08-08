#!/usr/bin/env bash
# Install / refresh Cursor plugin (+ OpenCode live loader via sync-runtime).
set -euo pipefail

REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workflow-toolkit}"
SHARE="${HOME}/.local/share/workflow-toolkit"
SKILLS_DIR="${HOME}/.cursor/skills"

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

if [ "$FROM_GITHUB" -eq 0 ] && [ ! -d "${LOCAL_ROOT}/packages/workit/cursor/.cursor-plugin" ]; then
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
  ROOT="$SHARE"
else
  ROOT="$LOCAL_ROOT"
fi

chmod +x "$ROOT/packages/workit/scripts/sync-runtime.sh" "$ROOT/packages/workit/scripts/"*.sh
# Prefer syncing from this ROOT (dev or freshly cloned share)
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/packages/workit/scripts/sync-runtime.sh"

# Drop stale CLI skill symlinks (duplicate /wf-* entries)
if [ -d "$SKILLS_DIR" ]; then
  rm -f "$SKILLS_DIR"/wk-*
fi

python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.cursor/settings.json")
data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)
prev = data.get("enabled_plugins")
if not isinstance(prev, dict):
    prev = {}
plugin = os.path.expanduser("~/.cursor/plugins/local/workflow-toolkit")
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
data.setdefault("mcpServers", {})["workflow-toolkit"] = {
    "command": "bash",
    "args": [
        "-lc",
        'exec "$HOME/.local/share/workflow-toolkit/packages/workit/scripts/run-cursor-mcp.sh" "$0"',
        "${workspaceFolder}",
    ],
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "Cursor plugin installed + auto-sync enabled (sessionStart)."
echo "Share: $SHARE"
ls "$HOME/.cursor/plugins/local/workflow-toolkit/skills" | grep '^wk-' || true
