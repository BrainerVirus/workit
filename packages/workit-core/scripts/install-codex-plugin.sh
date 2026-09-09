#!/usr/bin/env bash
# Install / refresh the Codex workit plugin from the local checkout or share clone.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
SHARE="${HOME}/.local/share/workit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$ROOT}"
PLUGIN_DIR="${HOME}/.codex/plugins/workit"

chmod +x "$ROOT/packages/workit-core/scripts/sync-runtime.sh"
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/packages/workit-core/scripts/sync-runtime.sh"

SOURCE="$DEV"
if [ ! -d "$SOURCE/packages/workit-codex/.codex-plugin" ] && [ -d "$SHARE/packages/workit-codex/.codex-plugin" ]; then
  SOURCE="$SHARE"
fi

mkdir -p "$PLUGIN_DIR"
rsync -a --delete "$SOURCE/packages/workit-codex/" "$PLUGIN_DIR/"

if ! bun "$ROOT/packages/workit-core/scripts/doctor-check.ts" cursor; then
  echo "FATAL: post-install doctor found problems after Codex plugin sync" >&2
  exit 1
fi

echo "Codex plugin installed at $PLUGIN_DIR"
echo "Complete an explicit v1 cutover before treating this as a generation switch."
