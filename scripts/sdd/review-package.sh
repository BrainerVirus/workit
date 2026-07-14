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
git diff "$BASE" "$HEAD" -- > "$DIFF"
python3 - "$DIFF" "$BASE" "$HEAD" "$BASE7" "$HEAD7" <<'PY'
import json, sys
diff_path, base, head, base7, head7 = sys.argv[1:]
print(json.dumps({"diff_path": diff_path, "base_sha": base, "head_sha": head, "base7": base7, "head7": head7}))
PY
