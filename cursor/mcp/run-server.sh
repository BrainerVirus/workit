#!/usr/bin/env bash
# Resolve monorepo root for Cursor MCP (install copy vs live monorepo).
set -euo pipefail

MCP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_DIR="$(CDPATH= cd -- "$MCP_DIR/.." && pwd)"
MARKER="${PLUGIN_DIR}/.workflow-toolkit-root"
SHARE="${HOME}/.local/share/workflow-toolkit"

if [ -n "${WORKFLOW_TOOLKIT_ROOT:-}" ] && [ -d "${WORKFLOW_TOOLKIT_ROOT}/scripts" ]; then
  ROOT="$WORKFLOW_TOOLKIT_ROOT"
elif [ -f "$MARKER" ]; then
  ROOT="$(tr -d '\n' <"$MARKER")"
elif [ -d "${SHARE}/scripts" ]; then
  ROOT="$SHARE"
else
  # Live monorepo: cursor/mcp → repo root
  ROOT="$(CDPATH= cd -- "$MCP_DIR/../.." && pwd)"
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
  echo "workflow-toolkit: bun not found (required for MCP server)" >&2
  exit 1
fi
exec "$BUN_BIN" "${MCP_DIR}/server.ts"
