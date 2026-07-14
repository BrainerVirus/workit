#!/usr/bin/env bash
# Resolve work-item date as epoch milliseconds (YouTrack kotlin.Long).
set -euo pipefail
CONFIG="${WORKFLOW_YOUTRACK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit/youtrack.json}"
DATE_INPUT="${1:-auto}"
python3 - "$CONFIG" "$DATE_INPUT" <<'PY'
import json, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo

cfg = json.loads(open(os.path.expanduser(sys.argv[1]), encoding="utf-8").read())
raw = sys.argv[2]
tz = ZoneInfo(cfg.get("timezone", "America/Santiago"))

if raw == "auto" or not raw:
    now = datetime.now(tz)
    dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
elif raw.isdigit():
    dt = datetime.fromtimestamp(int(raw) / 1000, tz=tz)
else:
    y, m, d = map(int, raw.split("-"))
    dt = datetime(y, m, d, tzinfo=tz)

date_ms = int(dt.timestamp() * 1000)
print(json.dumps({"dateMs": date_ms, "timezone": str(tz), "localDate": dt.date().isoformat()}))
PY
