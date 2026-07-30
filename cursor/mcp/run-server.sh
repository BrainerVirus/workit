#!/usr/bin/env bash
# ponytail: monorepo root from script location; workspace from Cursor ${workspaceFolder} arg
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
export WORKFLOW_TOOLKIT_ROOT="$ROOT"
if [ "${1:-}" != "" ]; then
  export WORKFLOW_WORKSPACE_ROOT="$1"
fi
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/server.js"
