#!/usr/bin/env bash
# Workit config, data and runtime dirs, as core/workit-paths.mjs resolves them:
# the functions are its CONFIG_DIR_SH, DATA_DIR_SH and RUNTIME_DIR_SH, verbatim
# (a test holds them).
workit_config_dir() {
  if [ -n "${WORKIT_CONFIG:-}" ]; then printf '%s\n' "$WORKIT_CONFIG"; return; fi
  if [ -n "${WORKIT_CONFIG_DIR:-}" ]; then printf '%s\n' "$WORKIT_CONFIG_DIR"; return; fi
  case "${XDG_CONFIG_HOME:-}" in /*) printf '%s\n' "$XDG_CONFIG_HOME/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\n' "${APPDATA:-$HOME/AppData/Roaming}/workit" ;;
    *) printf '%s\n' "$HOME/.config/workit" ;;
  esac
}
workit_data_dir() {
  case "${XDG_DATA_HOME:-}" in /*) printf '%s\n' "$XDG_DATA_HOME/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\n' "${LOCALAPPDATA:-$HOME/AppData/Local}/workit" ;;
    *) printf '%s\n' "$HOME/.local/share/workit" ;;
  esac
}
workit_runtime_dir() {
  case "${XDG_RUNTIME_DIR:-}" in /*) printf '%s\n' "$XDG_RUNTIME_DIR/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\n' "${TEMP:-${TMP:-/tmp}}/workit" ;;
    *) set -- "${TMPDIR:-/tmp}"; printf '%s\n' "${1%/}/workit-$(id -u)" ;;
  esac
}
resolve_config_dir() { workit_config_dir; }
