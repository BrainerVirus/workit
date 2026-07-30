#!/usr/bin/env bash
# Pin workflow-toolkit OpenCode plugin in ~/.config/opencode/opencode.json
set -euo pipefail

REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workflow-toolkit}"
REF="${1:-v0.3.18}"
CONFIG="${HOME}/.config/opencode/opencode.json"
PIN="workflow-toolkit-opencode@github:${REPO_SLUG}#${REF}"

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
elif not isinstance(plugins, list):
    plugins = list(plugins)

# Drop old file:// or prior github pins for this package
kept = []
for p in plugins:
    s = str(p)
    if "workflow-toolkit-opencode@" in s or s.endswith("workflow-toolkit-opencode"):
        continue
    kept.append(p)
kept.append(pin)
data["plugin"] = kept
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"Pinned: {pin}")
print(f"Wrote: {path}")
PY

echo "Restart OpenCode (or start a new session) to load the plugin."
