#!/usr/bin/env bash
# Install / refresh Cursor plugin (+ OpenCode live loader via sync-runtime).
set -euo pipefail

REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}"
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

if [ "$FROM_GITHUB" -eq 0 ] && [ ! -d "${LOCAL_ROOT}/packages/workit-cursor/.cursor-plugin" ]; then
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

chmod +x "$ROOT/packages/workit-core/scripts/sync-runtime.sh" "$ROOT/packages/workit-core/scripts/"*.sh
# Prefer syncing from this ROOT (dev or freshly cloned share)
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/packages/workit-core/scripts/sync-runtime.sh"

# Drop stale CLI skill symlinks (duplicate /wf-* and /wk-* entries)
if [ -d "$SKILLS_DIR" ]; then
  rm -f "$SKILLS_DIR"/wf-* "$SKILLS_DIR"/wk-*
fi

CURSOR_SETTINGS="$HOME/.cursor/settings.json" bun -e '
import fs from "node:fs";
import os from "node:os";
const path = process.env.CURSOR_SETTINGS!;
let data = {};
if (fs.existsSync(path)) data = JSON.parse(fs.readFileSync(path, "utf8"));
const prev = data.enabled_plugins && typeof data.enabled_plugins === "object" ? data.enabled_plugins : {};
const plugin = `${os.homedir()}/.cursor/plugins/local/workflow-toolkit`;
data.enabled_plugins = { ...prev, "workflow-toolkit": true, "local/workflow-toolkit": true };
data.plugin_dirs = [plugin];
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
'

CURSOR_MCP="$HOME/.cursor/mcp.json" bun -e '
import fs from "node:fs";
const path = process.env.CURSOR_MCP!;
const data = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : { mcpServers: {} };
data.mcpServers = data.mcpServers ?? {};
data.mcpServers["workflow-toolkit"] = {
  command: "bash",
  args: [
    "-lc",
    "exec \"$HOME/.local/share/workflow-toolkit/packages/workit-core/scripts/run-cursor-mcp.sh\" \"$0\"",
    "${workspaceFolder}",
  ],
};
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
'

echo "Cursor plugin installed + auto-sync enabled (sessionStart)."
echo "Share: $SHARE"
ls "$HOME/.cursor/plugins/local/workflow-toolkit/skills" | grep '^wk-' || true
