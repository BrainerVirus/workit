#!/usr/bin/env bash
set -euo pipefail
PROGRESS="${1:-}"
LINE="${2:-}"
[ -n "$PROGRESS" ] && [ -n "$LINE" ] || {
  echo 'ERROR: progress path and line required' >&2
  exit 1
}
python3 - "$PROGRESS" "$LINE" <<'PY'
import json, re, sys
from pathlib import Path

path, line = Path(sys.argv[1]), sys.argv[2].strip()
if not re.match(
    r"^Task\s+\d+:\s+complete\s+\(commits\s+[0-9a-f]{7,40}\.\.[0-9a-f]{7,40},",
    line,
    re.I,
):
    print("ERROR: invalid progress line format", file=sys.stderr)
    sys.exit(1)
path.parent.mkdir(parents=True, exist_ok=True)
with path.open("a", encoding="utf-8") as fh:
    fh.write(line + "\n")
print(json.dumps({"ok": True, "line": line, "progress_path": str(path)}))
PY
