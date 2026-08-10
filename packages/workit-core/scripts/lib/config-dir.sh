#!/usr/bin/env bash
# Resolve the config dir (workit default) with one-time legacy migration.
# Mirrors src/core/config.ts resolveConfigDir + ensureConfigDir.
# Env overrides bypass migration (explicit user intent wins); migration is
# idempotent: only runs when workit/ is absent; never overwrites, never
# deletes the legacy workflow-toolkit/ dir.
resolve_config_dir() {
  if [ -n "${WORKFLOW_TOOLKIT_CONFIG:-}" ]; then
    printf '%s\n' "$WORKFLOW_TOOLKIT_CONFIG"
    return
  fi
  if [ -n "${WORKFLOW_TOOLKIT_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$WORKFLOW_TOOLKIT_CONFIG_DIR"
    return
  fi
  local base="${XDG_CONFIG_HOME:-$HOME/.config}"
  local NEW="$base/workit"
  local LEGACY="$base/workflow-toolkit"
  if [ ! -d "$NEW" ] && [ -d "$LEGACY" ]; then
    mkdir -p "$NEW"
    if ! cp -r "$LEGACY/." "$NEW/"; then
      printf 'workit: warning: partial config migration from %s (kept in place; retry on next run)\n' "$LEGACY" >&2
    fi
  fi
  printf '%s\n' "$NEW"
}
