#!/usr/bin/env bash
# Stable entrypoint for Cursor MCP deeplink / ~/.cursor/mcp.json
set -euo pipefail
SHARE="${WORKFLOW_TOOLKIT_ROOT:-$HOME/.local/share/workflow-toolkit}"
exec "$SHARE/cursor/mcp/run-server.sh" "$@"
