#!/usr/bin/env bash
# Resolve the core package root for Cursor MCP (install copy vs live monorepo)
# and start the Node-compatible TS entry mcp/run-server.ts. Package-local only.
set -euo pipefail

MCP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

BUN_BIN="${BUN:-}"
if [ -z "$BUN_BIN" ]; then
  for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
    [ -x "$candidate" ] && BUN_BIN="$candidate" && break
  done
fi
if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "workit: bun not found (required for MCP server)" >&2
  exit 1
fi
exec "$BUN_BIN" "$MCP_DIR/run-server.ts" "$@"
