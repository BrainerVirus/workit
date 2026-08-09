#!/usr/bin/env bash
# Stable entrypoint for Cursor MCP deeplink / ~/.cursor/mcp.json
# Prefer the installed plugin copy (has node_modules); fall back to share.
set -euo pipefail
PLUGIN_MCP="${HOME}/.cursor/plugins/local/workflow-toolkit/mcp/run-server.sh"
SHARE_MCP="${HOME}/.local/share/workflow-toolkit/packages/workit-cursor/mcp/run-server.sh"
if [ -x "$PLUGIN_MCP" ]; then
  exec "$PLUGIN_MCP" "$@"
fi
exec "$SHARE_MCP" "$@"
