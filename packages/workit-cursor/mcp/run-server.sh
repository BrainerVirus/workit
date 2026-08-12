#!/usr/bin/env bash
# Cursor MCP launcher: prefer the self-contained Node bundle (dist/mcp-server.js);
# fall back to the dev TS entry via Bun.
set -euo pipefail
MCP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -f "$MCP_DIR/../dist/mcp-server.js" ] && command -v node >/dev/null 2>&1; then
  exec node "$MCP_DIR/../dist/mcp-server.js" "$@"
fi
exec "${BUN:-bun}" "$MCP_DIR/run-server.ts" "$@"
