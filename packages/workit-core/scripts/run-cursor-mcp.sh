#!/usr/bin/env bash
# Stable entrypoint for Cursor MCP deeplink / ~/.cursor/mcp.json (CA-17).
# Launch the published package's MCP bin through npx, never a repo-relative
# dist or share clone; a startup/network failure surfaces via npx's nonzero exit.
set -euo pipefail
exec npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp "$@"
