#!/usr/bin/env bash
# Install OpenCode plugin as a direct file:// load of the share tree (no bun pin cache).
# Sync runs before each `opencode` via ~/.zshrc wrapper.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
SHARE="${HOME}/.local/share/workflow-toolkit"
CONFIG="${HOME}/.config/opencode/opencode.json"
PIN="file://${SHARE}/src/plugin.ts"

chmod +x "$ROOT/scripts/sync-runtime.sh"
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/scripts/sync-runtime.sh"

mkdir -p "$(dirname "$CONFIG")"
if [ ! -f "$CONFIG" ]; then
  printf '%s\n' "{}" >"$CONFIG"
fi

python3 - "$CONFIG" "$PIN" <<'PY'
import json, sys
path, pin = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
plugins = data.get("plugin")
if plugins is None:
    plugins = []
elif isinstance(plugins, str):
    plugins = [plugins]
kept = []
for p in plugins:
    s = str(p)
    # Drop old pins and any previous file:// to this plugin
    if "workflow-toolkit-opencode" in s:
        continue
    if s.endswith("/workflow-toolkit/src/plugin.ts") or s.endswith("/workflow-toolkit/src/plugin.ts/"):
        continue
    if "workflow-toolkit/src/plugin.ts" in s:
        continue
    kept.append(p)
kept.append(pin)
data["plugin"] = kept
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"Pinned: {pin}")
PY

rm -f "${HOME}/.config/opencode/plugins/workflow-toolkit.ts"
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

echo "OpenCode loads: $PIN"
echo "Ensure ~/.zshrc opencode() runs sync-runtime before launch."
echo "Restart OpenCode, then type /wf-commit"
