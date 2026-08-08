#!/usr/bin/env bash
set -euo pipefail
CMD="${1:-}"
shift || true

# Safety guard: write operations (log-time, post-comment) require an explicit
# confirmation environment variable. This makes it impossible for tests, scripts,
# or stray calls to mutate a real YouTrack instance by accident.
if [ "$CMD" = "log-time" ] || [ "$CMD" = "post-comment" ]; then
  if [ "${WORKFLOW_YT_WRITE:-}" != "1" ]; then
    echo "ERROR: YouTrack write operations require WORKFLOW_YT_WRITE=1 (refusing to mutate production)" >&2
    exit 1
  fi
fi

CONFIG="${WORKFLOW_YOUTRACK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit/youtrack.json}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 - "$CONFIG" "$SCRIPT_DIR" "$CMD" "$@" <<'PY'
import json, os, subprocess, sys
from pathlib import Path

cfg = json.load(open(os.path.expanduser(sys.argv[1]), encoding="utf-8"))
script_dir = sys.argv[2]
cmd = sys.argv[3]
args = sys.argv[4:]
token_path = Path(os.path.expanduser(cfg["tokenFile"]))
if os.name != "nt" and token_path.stat().st_mode & 0o777 != 0o600:
    print(json.dumps({"ok": False, "error": "youtrack.token mode must be 0600"}))
    sys.exit(1)
token = token_path.read_text(encoding="utf-8").strip()
base = cfg["baseUrl"].rstrip("/")
auth = ["curl", "-fsS", "-H", f"Authorization: Bearer {token}", "-H", "Accept: application/json"]

def resolve_date_ms(date_raw):
    out = subprocess.check_output(
        ["bash", os.path.join(script_dir, "work-date-ms.sh"), date_raw or "auto"],
        text=True,
    )
    return json.loads(out)["dateMs"]

def post_json(url, body):
    try:
        return subprocess.check_output(
            auth + ["-H", "Content-Type: application/json", "-d", body, url],
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.CalledProcessError:
        print(json.dumps({"ok": False, "error": "YouTrack HTTP request failed"}))
        sys.exit(1)

if cmd == "log-time":
    issue, minutes, text = args[0], int(args[1]), args[2]
    date_raw = args[3] if len(args) > 3 else "auto"
    date_ms = resolve_date_ms(date_raw)
    body = json.dumps({"duration": {"minutes": minutes}, "text": text, "date": date_ms})
    out = post_json(f"{base}/api/issues/{issue}/timeTracking/workItems?fields=id,idReadable", body)
    created = json.loads(out)
    print(json.dumps({
        "ok": True,
        "issueId": issue,
        "workItemId": created.get("id"),
        "dateMs": date_ms,
        "minutes": minutes,
    }))
elif cmd == "post-comment":
    issue, text = args[0], args[1]
    body = json.dumps({"text": text})
    post_json(f"{base}/api/issues/{issue}/comments", body)
    print(json.dumps({"ok": True, "issueId": issue}))
else:
    print("ERROR: unknown subcommand", file=sys.stderr)
    sys.exit(1)
PY
