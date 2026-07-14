#!/usr/bin/env bash
set -euo pipefail
PROGRESS="${1:-}"
[ -n "$PROGRESS" ] && [ -f "$PROGRESS" ] || { printf '{"progress_lines":[],"completed_task_ids":[]}\n'; exit 0; }

python3 - "$PROGRESS" <<'PY'
import json, re, sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
progress_lines = [ln.strip() for ln in lines if ln.strip()]
completed = []
pat = re.compile(r"^Task\s+(\d+):\s+complete\b", re.I)
for ln in progress_lines:
    m = pat.match(ln)
    if m:
        completed.append(int(m.group(1)))
print(json.dumps({"progress_lines": progress_lines, "completed_task_ids": completed}))
PY
