#!/usr/bin/env bash
# Install OpenCode live loader (no bun cache pin — updates on every OpenCode start).
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
CONFIG="${HOME}/.config/opencode/opencode.json"

chmod +x "$ROOT/scripts/sync-runtime.sh"
"$ROOT/scripts/sync-runtime.sh"

# Drop github/file pins for this package — live loader replaces them
if [ -f "$CONFIG" ]; then
  python3 - "$CONFIG" <<'PY'
import json, sys
path = sys.argv[1]
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
    if "workflow-toolkit-opencode" in s:
        continue
    kept.append(p)
data["plugin"] = kept
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("Removed workflow-toolkit-opencode pin(s); using ~/.config/opencode/plugins/workflow-toolkit.ts")
PY
fi

# Clear stale bun installs so they cannot shadow the live loader
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

echo "OpenCode live loader ready at ~/.config/opencode/plugins/workflow-toolkit.ts"
echo "Restart OpenCode to load. Edits in the monorepo sync on each start."
