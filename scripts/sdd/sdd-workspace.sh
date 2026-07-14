#!/usr/bin/env bash
set -euo pipefail
SLUG="${1:-}"
[ -n "$SLUG" ] || { echo 'ERROR: slug required' >&2; exit 1; }

SDD_DIR="docs/superpowers/sdd/${SLUG}"
mkdir -p "$SDD_DIR"
touch "$SDD_DIR/progress.md"
printf '%s\n' "$SDD_DIR"
