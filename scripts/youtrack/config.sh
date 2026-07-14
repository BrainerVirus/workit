#!/usr/bin/env bash
set -euo pipefail
CMD="${1:-load}"
CONFIG="${WORKFLOW_YOUTRACK_CONFIG:-$HOME/.config/workflow-toolkit/youtrack.json}"
TOKEN_PLACEHOLDER='YOUR_TOKEN_HERE'

case "$CMD" in
  load)
    [ -f "$CONFIG" ] || { echo 'ERROR: missing youtrack.json' >&2; exit 1; }
    python3 - "$CONFIG" "$TOKEN_PLACEHOLDER" <<'PY'
import json, os, sys
from pathlib import Path

cfg_path = Path(os.path.expanduser(sys.argv[1]))
placeholder = sys.argv[2]
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
token_path = Path(os.path.expanduser(cfg.get("tokenFile", "")))
if not token_path.is_file():
    print(json.dumps({"ok": False, "error": "missing youtrack.token"}))
    sys.exit(1)
token = token_path.read_text(encoding="utf-8").strip()
if not token or token == placeholder or token.startswith(placeholder):
    print(json.dumps({"ok": False, "error": "token file still placeholder — edit locally, then /wf-status"}))
    sys.exit(1)
redacted = {k: v for k, v in cfg.items() if k != "tokenFile"}
redacted["tokenPresent"] = True
redacted["configPath"] = str(cfg_path.resolve())
redacted["tokenPath"] = str(token_path.resolve())
print(json.dumps(redacted))
PY
    ;;
  *)
    echo 'ERROR: unknown command' >&2
    exit 1
    ;;
esac
