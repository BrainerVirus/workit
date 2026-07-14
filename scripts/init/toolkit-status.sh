#!/usr/bin/env bash
# Combined health check: filesystem + YouTrack API + VCS API verify (tools-only).
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

export WT_STATUS
WT_STATUS=$(bash "$SCRIPT_DIR/status.sh")

PLACEHOLDER=$(printf '%s' "$WT_STATUS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d.get('items',[]):
    if i.get('id')=='youtrack_token':
        print('true' if i.get('placeholder') else 'false')
        break
else:
    print('false')
")

if [ "$PLACEHOLDER" = "true" ]; then
  export WT_VERIFY='{"ok":false,"error":"token still placeholder YOUR_TOKEN_HERE"}'
else
  export WT_VERIFY
  WT_VERIFY=$(bash "$PLUGIN_ROOT/scripts/youtrack/verify-token.sh" 2>/dev/null || true)
  if [ -z "$WT_VERIFY" ]; then
    WT_VERIFY='{"ok":false,"error":"verify-token produced no output"}'
  fi
  export WT_VERIFY
fi

VCS_PLACEHOLDER=$(printf '%s' "$WT_STATUS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
vcfg=d.get('vcs_config') or {}
prov=(vcfg.get('provider') or 'gitlab').lower()
tid='gitlab_token' if prov=='gitlab' else 'github_token'
for i in d.get('items',[]):
    if i.get('id')==tid:
        print('true' if i.get('placeholder') else 'false')
        break
else:
    print('true')
")

if [ "$VCS_PLACEHOLDER" = "true" ]; then
  export WT_VCS_VERIFY='{"ok":false,"error":"vcs token still placeholder YOUR_TOKEN_HERE"}'
else
  export WT_VCS_VERIFY
  WT_VCS_VERIFY=$(bash "$PLUGIN_ROOT/scripts/vcs/verify-token.sh" 2>/dev/null || true)
  if [ -z "$WT_VCS_VERIFY" ]; then
    WT_VCS_VERIFY='{"ok":false,"error":"vcs verify produced no output"}'
  fi
  export WT_VCS_VERIFY
fi

python3 <<'PY'
import json, os

status = json.loads(os.environ["WT_STATUS"])
verify = json.loads(os.environ["WT_VERIFY"])
vcs_verify = json.loads(os.environ["WT_VCS_VERIFY"])

token_item = next((i for i in status.get("items", []) if i["id"] == "youtrack_token"), {})
placeholder = token_item.get("placeholder", False)

vcs_cfg = status.get("vcs_config") or {}
provider = (vcs_cfg.get("provider") or "gitlab").lower()
vcs_token_id = "gitlab_token" if provider == "gitlab" else "github_token"
vcs_token_item = next((i for i in status.get("items", []) if i["id"] == vcs_token_id), {})
vcs_placeholder = vcs_token_item.get("placeholder", True)
vcs_json_ok = next((i["ok"] for i in status.get("items", []) if i["id"] == "vcs_json"), False)

status["youtrack_verify"] = verify
status["youtrack_ok"] = bool(verify.get("ok")) if not placeholder else False
status["vcs_verify"] = vcs_verify
status["vcs_ok"] = bool(vcs_verify.get("ok")) if vcs_json_ok and not vcs_placeholder else False

fs_ready = all(i.get("ok") for i in status.get("items", []) if i.get("required", True))
status["ready"] = fs_ready and status["youtrack_ok"] and (not vcs_json_ok or status["vcs_ok"])

if placeholder:
    token_path = token_item.get("token_edit_path") or token_item.get("path", "")
    create_url = token_item.get("token_create_url") or (status.get("youtrack_config") or {}).get("tokenCreate", {}).get("createUrl")
    status["token_edit_path"] = token_path
    if create_url:
        status["token_create_url"] = create_url
    status["next_step"] = (
        "Open the YouTrack create-token URL, New token (name workflow-toolkit, scope YouTrack), "
        "paste into the token file, save, then run /wf-status"
        if create_url
        else "Open the YouTrack token file, replace YOUR_TOKEN_HERE, save, then run /wf-status"
    )
elif vcs_json_ok and vcs_placeholder:
    path = vcs_token_item.get("token_edit_path") or ""
    status["vcs_token_edit_path"] = path
    status["next_step"] = (
        f"Open {path}, paste your {provider} token, save, then run /wf-status"
    )
elif not status["youtrack_ok"]:
    status["next_step"] = "Fix YouTrack token or re-run /wf-init"
elif vcs_json_ok and not status["vcs_ok"]:
    status["next_step"] = f"Fix {provider} token in vcs config or re-run /wf-init"
elif status["ready"]:
    status["next_step"] = "All checks passed"

print(json.dumps(status, indent=2))
PY
