#!/usr/bin/env bash
set -euo pipefail
CONFIG="${1:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit/youtrack.json}"
python3 - "$CONFIG" <<'PY'
import json, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo

cfg_path = os.path.expanduser(sys.argv[1])
cfg = json.loads(open(cfg_path, encoding="utf-8").read())
tz = ZoneInfo(cfg.get("timezone", "America/Santiago"))
now = datetime.now(tz)
cutoff = cfg.get("greetingCutoff", "12:00")
hour, minute = map(int, cutoff.split(":"))
greetings = cfg.get("greetings", {})
greeting = greetings.get("morning", "buenos días") if (now.hour, now.minute) < (hour, minute) else greetings.get("afternoon", "buenas tardes")
mention = cfg.get("defaultMention", "Alejandra.Flores")
print(f"@{mention} Hola, {greeting}.")
PY
