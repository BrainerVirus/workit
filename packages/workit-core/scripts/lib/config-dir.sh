#!/usr/bin/env bash
# Resolve the workit config dir. Mirrors src/core/config.ts resolveConfigDir:
# WORKIT_CONFIG, then WORKIT_CONFIG_DIR, then $XDG_CONFIG_HOME/workit.
resolve_config_dir() {
  if [ -n "${WORKIT_CONFIG:-}" ]; then
    printf '%s\n' "$WORKIT_CONFIG"
    return
  fi
  if [ -n "${WORKIT_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$WORKIT_CONFIG_DIR"
    return
  fi
  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/workit"
}
