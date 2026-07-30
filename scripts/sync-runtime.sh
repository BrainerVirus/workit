#!/usr/bin/env bash
# Sync workflow-toolkit runtime for Cursor + OpenCode.
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
  # Another sync in progress — skip
  exit 0
fi

SRC=""
if [ -f "${DEV}/src/plugin.ts" ] && [ -d "${DEV}/cursor/.cursor-plugin" ]; then
  SRC="$DEV"
elif [ -d "${SHARE}/.git" ]; then
  git -C "$SHARE" fetch --quiet origin 2>/dev/null || true
  git -C "$SHARE" pull --ff-only --quiet origin main 2>/dev/null || true
  SRC="$SHARE"
elif [ ! -d "${SHARE}/src" ]; then
  mkdir -p "$(dirname "$SHARE")"
  git clone --depth 1 "git@github.com:${REPO_SLUG}.git" "$SHARE" 2>/dev/null || exit 0
  SRC="$SHARE"
else
  SRC="$SHARE"
fi

if [ "$SRC" != "$SHARE" ]; then
  mkdir -p "$SHARE"
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
  "$SHARE/cursor/" "$PLUGIN_DIR/"
printf '%s\n' "$SHARE" >"$PLUGIN_DIR/.workflow-toolkit-root"
chmod +x "$PLUGIN_DIR/hooks/session-start" "$PLUGIN_DIR/mcp/run-server.sh" 2>/dev/null || true

if [ ! -d "$PLUGIN_DIR/mcp/node_modules" ]; then
  (cd "$PLUGIN_DIR/mcp" && npm install --silent) || true
fi

# OpenCode live loader — bypasses bun plugin cache
mkdir -p "$OPENCODE_PLUGINS"
python3 - "$SHARE" "${OPENCODE_PLUGINS}/workflow-toolkit.ts" <<'PY'
import json, sys
share, out = sys.argv[1], sys.argv[2]
open(out, "w").write(
    "import { spawnSync } from \"node:child_process\"\n"
    "import path from \"node:path\"\n"
    "import { pathToFileURL } from \"node:url\"\n"
    f"\nconst share = {json.dumps(share)}\n"
    "spawnSync(\"bash\", [path.join(share, \"scripts\", \"sync-runtime.sh\")], {\n"
    "  stdio: \"ignore\",\n"
    "})\n"
    "const mod = await import(pathToFileURL(path.join(share, \"src\", \"plugin.ts\")).href)\n"
    "export default mod.default\n"
)
PY

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

exit 0
