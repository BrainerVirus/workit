#!/usr/bin/env bash
# YouTrack permanent-token helper — deep link to Account Security + defaults to type in the dialog.
# YouTrack has no URL prefill for token name/scopes (unlike GitLab/GitHub PAT forms).
set -euo pipefail

CONFIG="${WORKFLOW_YOUTRACK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit/youtrack.json}"
TOKEN_NAME="${WORKFLOW_YT_TOKEN_NAME:-workflow-toolkit}"

python3 - "$CONFIG" "$TOKEN_NAME" <<'PY'
import json, sys
from pathlib import Path
from urllib.parse import quote, urlencode

cfg_path = Path(sys.argv[1]).expanduser()
token_name = sys.argv[2]
default_desc = "OpenCode workflow-toolkit — /wf-issue-update and /wf-meetings"

def load_cfg():
    if not cfg_path.is_file():
        return {}
    return json.loads(cfg_path.read_text(encoding="utf-8"))

cfg = load_cfg()
defaults = cfg.get("tokenDefaults") or {}
name = defaults.get("name") or token_name
desc = defaults.get("description") or default_desc
scopes = defaults.get("scopes") or ["YouTrack"]
base = (cfg.get("baseUrl") or "https://enghouseamg.youtrack.cloud").rstrip("/")
token_file = cfg.get("tokenFile") or str(cfg_path.parent / "youtrack.token")
tab = defaults.get("profileTab") or "account-security"

create_url = f"{base}/users/me?{urlencode({'tab': tab}, quote_via=quote)}"
docs_url = "https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html"

print(json.dumps({
    "tokenName": name,
    "tokenDescription": desc,
    "scopes": scopes,
    "tokenFile": str(Path(token_file).expanduser()),
    "createUrl": create_url,
    "docsUrl": docs_url,
    "prefillSupported": False,
    "steps": [
        "Profile → Account Security → **New token** (or open createUrl)",
        f"Name: **{name}**",
        f"Scope: **{', '.join(scopes)}** only — remove other services",
        "**Create token** → copy immediately (shown once)",
        f"Paste into token file → save → `/wf-status`",
    ],
}, indent=2))
PY
