#!/usr/bin/env bash
set -euo pipefail
SDD_DIR="${1:-}"
BASE="${2:-}"
HEAD="${3:-}"
[ -n "$SDD_DIR" ] && [ -n "$BASE" ] && [ -n "$HEAD" ] || {
  echo 'ERROR: usage: review-package.sh <sdd_dir> <base_sha> <head_sha>' >&2
  exit 1
}
mkdir -p "$SDD_DIR"
BASE7="${BASE:0:7}"
HEAD7="${HEAD:0:7}"
DIFF="$SDD_DIR/review-${BASE7}..${HEAD7}.diff"
git diff "$BASE" "$HEAD" > "$DIFF"
python3 -c "import json; print(json.dumps({'diff_path': '$DIFF', 'base_sha': '$BASE', 'head_sha': '$HEAD', 'base7': '$BASE7', 'head7': '$HEAD7'}))"
