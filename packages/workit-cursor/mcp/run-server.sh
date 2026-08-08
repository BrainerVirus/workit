#!/usr/bin/env bash
# Resolve the core package root for Cursor MCP (install copy vs live monorepo).
set -euo pipefail

MCP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(CDPATH= cd -- "$MCP_DIR/.." && pwd)"
MARKER="${PLUGIN_DIR}/.workflow-toolkit-root"
# ponytail: config-stability alias — the installed share keeps the legacy
# workflow-toolkit path (existing installs); "workit" is the package/brand name.
SHARE="${HOME}/.local/share/workflow-toolkit"

if [ -n "${WORKFLOW_TOOLKIT_ROOT:-}" ] && [ -d "${WORKFLOW_TOOLKIT_ROOT}/scripts" ]; then
  ROOT="$WORKFLOW_TOOLKIT_ROOT"
elif [ -f "$MARKER" ]; then
  ROOT="$(tr -d '\n' <"$MARKER")"
elif [ -d "${SHARE}/packages/workit-core/scripts" ]; then
  ROOT="$SHARE/packages/workit-core"
else
  # Live monorepo: workit-cursor/mcp → packages/workit-core (workspace sibling)
  ROOT="$(CDPATH= cd -- "$MCP_DIR/../../workit-core" && pwd)"
fi

export WORKFLOW_TOOLKIT_ROOT="$ROOT"
if [ "${1:-}" != "" ]; then
  export WORKFLOW_WORKSPACE_ROOT="$1"
fi

BUN_BIN="${BUN:-}"
if [ -z "$BUN_BIN" ]; then
  for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
    [ -x "$candidate" ] && BUN_BIN="$candidate" && break
  done
fi
if [ -z "$BUN_BIN" ]; then
  echo "workit: bun not found (required for MCP server)" >&2
  exit 1
fi
# Execute the server next to this script: server.ts imports @brainervirus/workit-core,
# resolved via node_modules (workspace link in the monorepo, npm install in the
# cursor plugin copy). Make the resolved bun visible to child scripts that exec
# bare `bun` (the port wrappers) when it lives outside PATH (e.g. ~/.bun/bin).
export PATH="$(dirname "$BUN_BIN"):$PATH"
exec "$BUN_BIN" "$MCP_DIR/server.ts"
