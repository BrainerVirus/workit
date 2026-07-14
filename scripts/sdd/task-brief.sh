#!/usr/bin/env bash
set -euo pipefail
SDD_DIR="${1:-}"
TASK_ID="${2:-}"
SECTION_FILE="${3:-}"
[ -n "$SDD_DIR" ] && [ -n "$TASK_ID" ] && [ -f "$SECTION_FILE" ] || {
  echo 'ERROR: usage: task-brief.sh <sdd_dir> <task_id> <section_text_file>' >&2
  exit 1
}
mkdir -p "$SDD_DIR"
OUT="$SDD_DIR/task-${TASK_ID}-brief.md"
{
  printf '# Task %s brief\n\n' "$TASK_ID"
  cat "$SECTION_FILE"
} > "$OUT"
printf '%s\n' "$OUT"
