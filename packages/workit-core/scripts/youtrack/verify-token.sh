#!/usr/bin/env bash
# Read-only YouTrack token check — GET /api/users/me (no work items created).
set -euo pipefail

CONFIG="${WORKFLOW_YOUTRACK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit/youtrack.json}"

python3 - "$CONFIG" <<'PY'
import json, os, subprocess, sys
from pathlib import Path

cfg_path = Path(os.path.expanduser(sys.argv[1]))
if not cfg_path.is_file():
    print(json.dumps({"ok": False, "error": "missing youtrack.json"}))
    sys.exit(1)

cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
token_path = Path(os.path.expanduser(cfg.get("tokenFile", "")))
if not token_path.is_file():
    print(json.dumps({"ok": False, "error": "missing youtrack.token"}))
    sys.exit(1)
if os.name != "nt" and token_path.stat().st_mode & 0o777 != 0o600:
    print(json.dumps({"ok": False, "error": "youtrack.token mode must be 0600"}))
    sys.exit(1)

token = token_path.read_text(encoding="utf-8").strip()
if not token:
    print(json.dumps({"ok": False, "error": "empty token file"}))
    sys.exit(1)

if token == "YOUR_TOKEN_HERE" or token.startswith("YOUR_TOKEN_HERE"):
    print(json.dumps({
        "ok": False,
        "error": "token file still has placeholder YOUR_TOKEN_HERE — edit the file locally, then run /wk-status",
        "path": str(token_path),
    }))
    sys.exit(1)

base = cfg.get("baseUrl", "").rstrip("/")
if not base:
    print(json.dumps({"ok": False, "error": "baseUrl missing in config"}))
    sys.exit(1)

url = f"{base}/api/users/me?fields=id,login,name,email"
cmd = [
    "curl", "-fsS",
    "-H", f"Authorization: Bearer {token}",
    "-H", "Accept: application/json",
    url,
]
try:
    out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
    me = json.loads(out)
except subprocess.CalledProcessError as e:
    body = (e.output or "").strip()
    err = "authentication failed (401/403)" if e.returncode == 22 else f"HTTP error: {body[:200]}"
    print(json.dumps({"ok": False, "error": err, "http_status": e.returncode}))
    sys.exit(1)
except json.JSONDecodeError:
    print(json.dumps({"ok": False, "error": "invalid JSON from YouTrack /api/users/me"}))
    sys.exit(1)

result = {
    "ok": True,
    "method": "GET /api/users/me",
    "baseUrl": base,
    "login": me.get("login"),
    "name": me.get("name"),
    "email": me.get("email"),
    "id": me.get("id"),
}

meeting = cfg.get("meetingIssue")
if meeting:
    issue_url = f"{base}/api/issues/{meeting}?fields=id,idReadable,summary"
    try:
        iout = subprocess.check_output([
            "curl", "-fsS",
            "-H", f"Authorization: Bearer {token}",
            "-H", "Accept: application/json",
            issue_url,
        ], stderr=subprocess.STDOUT, text=True)
        issue = json.loads(iout)
        result["meetingIssue"] = meeting
        result["meetingIssueReadable"] = True
        result["meetingIssueSummary"] = issue.get("summary")
    except subprocess.CalledProcessError:
        result["meetingIssue"] = meeting
        result["meetingIssueReadable"] = False
        result["warning"] = f"token valid but cannot read issue {meeting}"

print(json.dumps(result, indent=2))
PY
