#!/usr/bin/env bash
# Install OpenCode plugin: file:// pin to monorepo (or share clone) + native skill/command links.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
SHARE="${HOME}/.local/share/workflow-toolkit"
DEV_DEFAULT="${HOME}/Documents/projects/personal/workflow-toolkit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$DEV_DEFAULT}"
CONFIG="${HOME}/.config/opencode/opencode.json"

chmod +x "$ROOT/scripts/sync-runtime.sh"
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/scripts/sync-runtime.sh"

# Prefer monorepo with .git. file:// pins skip opencode's bundled npm installer —
# git+file:// installs an EMPTY cache dir and fails silently, so the plugin never
# loads after restart. The pinned entry resolves via packages/workit/package.json main.
if [ -d "${DEV}/.git" ] && [ -f "${DEV}/packages/workit/src/plugin.ts" ]; then
  PIN="file://${DEV}/packages/workit/src/plugin.ts"
elif [ -d "${SHARE}/.git" ] && [ -f "${SHARE}/packages/workit/src/plugin.ts" ]; then
  PIN="file://${SHARE}/packages/workit/src/plugin.ts"
else
  # Last resort: ensure share is a clone, then pin it
  if [ ! -d "${SHARE}/.git" ]; then
    TMP=$(mktemp -d)
    git clone --depth 1 "git@github.com:${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workflow-toolkit}.git" "$TMP"
    rsync -a --delete --exclude node_modules --exclude cursor/mcp/node_modules "$TMP/" "$SHARE/"
    rm -rf "$TMP"
  fi
  PIN="file://${SHARE}/packages/workit/src/plugin.ts"
fi

mkdir -p "$(dirname "$CONFIG")"
[ -f "$CONFIG" ] || printf '%s\n' "{}" >"$CONFIG"

python3 - "$CONFIG" "$PIN" <<'PY'
import json, sys
path, pin = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
plugins = data.get("plugin") or []
if isinstance(plugins, str):
    plugins = [plugins]
kept = []
for p in plugins:
    s = str(p)
    if "workflow-toolkit" in s:
        continue
    kept.append(p)
kept.append(pin)
data["plugin"] = kept
# Drop share skills.paths — native ~/.config/opencode/skills links avoid triple-load dups
skills = data.get("skills")
if isinstance(skills, dict):
    paths = [
        p
        for p in (skills.get("paths") or [])
        if "workflow-toolkit" not in str(p)
    ]
    skills["paths"] = paths
    data["skills"] = skills
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("Pinned:", pin)
print("Native skills/commands via ~/.config/opencode/{skills,commands}")
PY

# file:// pin already ships skills + registers /wk-* via plugin config.
# Remove leftover native links so OpenCode does not warn about duplicate skill names.
find "${HOME}/.config/opencode/skills" -maxdepth 1 -name 'wf-*' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/skill" -maxdepth 1 -name 'wf-*' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/commands" -maxdepth 1 -name 'wf-*.md' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/command" -maxdepth 1 -name 'wf-*.md' -exec rm -f {} + 2>/dev/null || true
rm -f "${HOME}/.config/opencode/plugins/workflow-toolkit.ts"
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

# Post-install verification: file:// pins skip the installer, so a missing/empty
# pinned entry is a silent no-op. Fail loudly instead of pretending it worked.
PLUGIN_ENTRY="${PIN#file://}"
if [ ! -s "$PLUGIN_ENTRY" ]; then
  echo "FATAL: pinned plugin entry missing or empty: $PLUGIN_ENTRY" >&2
  echo "The file:// pin written to $CONFIG will not load after restart." >&2
  echo "Restore the monorepo (or fix WORKFLOW_TOOLKIT_DEV) and re-run this script." >&2
  exit 1
fi

echo "OpenCode install done. Fully quit all opencode processes, then restart."