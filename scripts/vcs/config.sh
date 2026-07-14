#!/usr/bin/env bash
# Load workflow-toolkit VCS config (GitLab / GitHub). Token never printed.
set -euo pipefail

CMD="${1:-load}"
CONFIG="${WORKFLOW_VCS_CONFIG:-$HOME/.config/workflow-toolkit/vcs.json}"
TOKEN_PLACEHOLDER='YOUR_TOKEN_HERE'

case "$CMD" in
  load|summary)
    python3 - "$CONFIG" "$TOKEN_PLACEHOLDER" "$CMD" <<'PY'
import json, os, sys
from pathlib import Path

cfg_path = Path(os.path.expanduser(sys.argv[1]))
placeholder = sys.argv[2]
mode = sys.argv[3]

if not cfg_path.is_file():
    print(json.dumps({"ok": False, "error": "missing vcs.json"}))
    sys.exit(1)

cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
provider = (cfg.get("provider") or "gitlab").lower()
prov = cfg.get(provider) or {}
token_file = prov.get("tokenFile") or str(Path.home() / f".config/workflow-toolkit/{provider}.token")
token_path = Path(os.path.expanduser(token_file))
token_ok = False
token_placeholder = True
if token_path.is_file():
    token = token_path.read_text(encoding="utf-8").strip()
    token_placeholder = not token or token == placeholder or token.startswith(placeholder)
    token_ok = not token_placeholder

out = {
    "ok": True,
    "configPath": str(cfg_path.resolve()),
    "provider": provider,
    "defaultTargetBranch": cfg.get("defaultTargetBranch", "develop"),
    "pr": cfg.get("pr") or {},
    "tokenPath": str(token_path.resolve()),
    "tokenPresent": token_path.is_file(),
    "tokenReady": token_ok,
}
if provider == "gitlab":
    out["gitlab"] = {
        "host": prov.get("host", "gitlab.com"),
        "apiUrl": prov.get("apiUrl", "https://gitlab.com/api/v4"),
    }
elif provider == "github":
    out["github"] = {
        "host": prov.get("host", "github.com"),
    }

if mode == "summary":
    out.pop("tokenPath", None)
print(json.dumps(out))
PY
    ;;
  *)
    echo 'ERROR: unknown command (load|summary)' >&2
    exit 1
    ;;
esac
