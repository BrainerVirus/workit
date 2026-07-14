#!/usr/bin/env bash
set -euo pipefail
TEXT="${*:-}"
[ -n "$TEXT" ] || { echo 'ERROR: duration text required' >&2; exit 1; }
python3 - "$TEXT" <<'PY'
import json, re, sys
text = sys.argv[1].lower().strip()
total = 0
for h in re.findall(r"(\d+)\s*h", text):
    total += int(h) * 60
for m in re.findall(r"(\d+)\s*m", text):
    total += int(m)
if total == 0 and re.fullmatch(r"\d+", text):
    total = int(text)
if total <= 0:
    print("ERROR: could not parse duration", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"minutes": total, "text": sys.argv[1].strip()}))
PY
