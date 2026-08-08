#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
CONFIRMED="${2:-false}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CONFIG_DIR="${WORKFLOW_TOOLKIT_CONFIG:-${WORKFLOW_TOOLKIT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit}}"
TOKEN_PLACEHOLDER='YOUR_TOKEN_HERE'

if [ "$CONFIRMED" != "true" ]; then
  echo 'ERROR: confirmed=true required to write config' >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"

write_youtrack_json() {
  python3 - "$CONFIG_DIR/youtrack.json" <<'PY'
import json, os, sys
from pathlib import Path

out = Path(sys.argv[1])
cfg = {
    "baseUrl": os.environ.get("WORKFLOW_YT_BASE_URL", "https://enghouseamg.youtrack.cloud"),
    "tokenFile": os.environ.get("WORKFLOW_YT_TOKEN_FILE", str(out.parent / "youtrack.token")),
    "timezone": os.environ.get("WORKFLOW_YT_TIMEZONE", "America/Santiago"),
    "locale": "es-CL",
    "defaultMention": os.environ.get("WORKFLOW_YT_MENTION", "Alejandra.Flores"),
    "greetings": {"morning": "buenos días", "afternoon": "buenas tardes"},
    "greetingCutoff": "12:00",
    "meetingIssue": os.environ.get("WORKFLOW_YT_MEETING_ISSUE", "IRPT-12"),
    "meetingIssues": {
        "general": {
            "issue": os.environ.get("WORKFLOW_YT_MEETING_ISSUE", "IRPT-12"),
            "label": "General meetings (Reuniones internas Team IRP)",
            "workItemText": "Reuniones",
        },
        "web": {
            "issue": os.environ.get("WORKFLOW_YT_WEB_MEETING_ISSUE", "NSXFT-21"),
            "label": "Web meetings",
            "workItemText": "Reuniones web",
            "url": "https://enghouseamg.youtrack.cloud/projects/NSXFT/issues/NSXFT-21",
        },
    },
    "commentHeader": "# Actualización",
    "attachmentsHeaderImages": "## Adjunto capturas",
    "attachmentsHeaderFiles": "## Archivos adjuntos",
    "attachmentsHeaderMixed": "## Adjuntos",
    "tokenDefaults": {
        "name": "workflow-toolkit",
        "description": "OpenCode flowkit — /wf-issue-update and /wf-meetings",
        "scopes": ["YouTrack"],
        "profileTab": "account-security",
    },
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"path": str(out)}))
PY
}

write_token_placeholder() {
  printf '%s\n' "$TOKEN_PLACEHOLDER" > "$CONFIG_DIR/youtrack.token"
  chmod 600 "$CONFIG_DIR/youtrack.token"
  python3 - "$CONFIG_DIR/youtrack.token" "$TOKEN_PLACEHOLDER" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]).resolve()
print(json.dumps({
    "path": str(p),
    "token_edit_path": str(p),
    "placeholder": sys.argv[2],
}))
PY
}

write_vcs_json() {
  python3 - "$CONFIG_DIR/vcs.json" <<'PY'
import json, os, sys
from pathlib import Path

out = Path(sys.argv[1])
cfg_dir = out.parent
cfg = {
    "provider": os.environ.get("WORKFLOW_VCS_PROVIDER", "gitlab"),
    "defaultTargetBranch": os.environ.get("WORKFLOW_VCS_TARGET_BRANCH", "develop"),
    "gitlab": {
        "host": os.environ.get("WORKFLOW_GITLAB_HOST", "gitlab.com"),
        "apiUrl": os.environ.get("WORKFLOW_GITLAB_API_URL", "https://gitlab.com/api/v4"),
        "tokenFile": str(cfg_dir / "gitlab.token"),
    },
    "github": {
        "host": os.environ.get("WORKFLOW_GITHUB_HOST", "github.com"),
        "tokenFile": str(cfg_dir / "github.token"),
    },
    "pr": {
        "squashOnMerge": True,
        "removeSourceBranch": True,
        "pushBranch": True,
        "confirmSkip": True,
    },
    "tokenDefaults": {
        "name": "workflow-toolkit",
        "description": "OpenCode flowkit — /wf-pr and glab/gh",
        "gitlabScopes": ["api"],
        "githubPermissions": {
            "pull_requests": "write",
            "contents": "write",
            "metadata": "read",
        },
        "githubClassicScopes": ["repo"],
    },
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"path": str(out)}))
PY
}

write_vcs_token_placeholder() {
  local dest=$1
  printf '%s\n' "$TOKEN_PLACEHOLDER" > "$dest"
  chmod 600 "$dest"
  python3 - "$dest" "$TOKEN_PLACEHOLDER" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]).resolve()
print(json.dumps({"path": str(p), "token_edit_path": str(p), "placeholder": sys.argv[2]}))
PY
}

case "$ACTION" in
  youtrack_json)
    write_youtrack_json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'action':'youtrack_json','ok':True,**d}))"
    ;;
  youtrack_token_placeholder)
    write_token_placeholder | python3 -c "
import json,sys
d=json.load(sys.stdin)
p=d['token_edit_path']
print(json.dumps({
    'action':'youtrack_token_placeholder',
    'ok':True,
    **d,
    'instruction':f'Open {p} in your editor, replace YOUR_TOKEN_HERE with your YouTrack permanent token, save, then run /wf-status',
}))
"
    ;;
  youtrack_scaffold)
  JSON_OUT=$(write_youtrack_json)
  TOK_OUT=$(write_token_placeholder)
  python3 - "$JSON_OUT" "$TOK_OUT" "$PLUGIN_ROOT" <<'PY'
import json, subprocess, sys
from pathlib import Path
j, t, plugin_root = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
token_path = Path(t["token_edit_path"])
config_path = Path(j["path"]).resolve()
cfg = json.loads(config_path.read_text(encoding="utf-8"))
base = (cfg.get("baseUrl") or "").rstrip("/")
meeting = cfg.get("meetingIssue") or ""

token_create = {}
urls_script = Path(plugin_root) / "scripts/youtrack/token-create-url.sh"
if urls_script.is_file():
    r = subprocess.run(
        ["bash", str(urls_script)],
        capture_output=True,
        text=True,
        env={**__import__("os").environ, "WORKFLOW_YOUTRACK_CONFIG": str(config_path)},
    )
    if r.returncode == 0 and r.stdout.strip():
        token_create = json.loads(r.stdout)

print(json.dumps({
    "action": "youtrack_scaffold",
    "ok": True,
    "youtrack_json": str(config_path),
    "youtrack_token": str(token_path),
    "token_edit_path": str(token_path),
    "token_create_url": token_create.get("createUrl"),
    "token_create": token_create,
    "config_edit_path": str(config_path),
    "placeholder": t["placeholder"],
    "youtrack_config": {
        "config_edit_path": str(config_path),
        "baseUrl": base,
        "meetingIssue": meeting,
        "meetingIssueUrl": f"{base}/issue/{meeting}" if base and meeting else None,
        "defaultMention": cfg.get("defaultMention"),
        "timezone": cfg.get("timezone"),
        "locale": cfg.get("locale"),
        "tokenCreate": token_create,
        "timeLogging": {
            "meetings": {"issue": meeting, "skill": "/wf-meetings", "logsTime": True, "postsComment": False},
            "taskWork": {
                "issueSource": "active spec/plan **YouTrack:** field or --issue",
                "skill": "/wf-issue-update",
                "logsTime": True,
                "postsComment": True,
            },
        },
    },
    "instruction": (
        f"Open the create-token URL, New token → name workflow-toolkit, scope YouTrack, "
        f"paste into {token_path}, then /wf-status."
    ),
}))
PY
    ;;
  vcs_scaffold)
    VCS_OUT=$(write_vcs_json)
    GL_OUT=$(write_vcs_token_placeholder "$CONFIG_DIR/gitlab.token")
    GH_OUT=$(write_vcs_token_placeholder "$CONFIG_DIR/github.token")
    python3 - "$VCS_OUT" "$GL_OUT" "$GH_OUT" "$PLUGIN_ROOT" <<'PY'
import json, subprocess, sys
from pathlib import Path
v, gl, gh, plugin_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
v, gl, gh = json.loads(v), json.loads(gl), json.loads(gh)
config_path = Path(v["path"]).resolve()
cfg = json.loads(config_path.read_text(encoding="utf-8"))
provider = cfg.get("provider", "gitlab")
token_urls = {}
urls_script = Path(plugin_root) / "scripts/vcs/token-create-urls.sh"
if urls_script.is_file():
    r = subprocess.run(
        ["bash", str(urls_script)],
        capture_output=True,
        text=True,
        env={**__import__("os").environ, "WORKFLOW_VCS_CONFIG": str(config_path)},
    )
    if r.returncode == 0 and r.stdout.strip():
        token_urls = json.loads(r.stdout)
active = token_urls.get("active") or {}
active_path = gl["token_edit_path"] if provider == "gitlab" else gh["token_edit_path"]
print(json.dumps({
    "action": "vcs_scaffold",
    "ok": True,
    "vcs_json": str(config_path),
    "config_edit_path": str(config_path),
    "gitlab_token": gl["token_edit_path"],
    "github_token": gh["token_edit_path"],
    "token_edit_path": active_path,
    "token_create_url": active.get("createUrl"),
    "token_create_urls": token_urls,
    "vcs_config": {
        "config_edit_path": str(config_path),
        "provider": provider,
        "defaultTargetBranch": cfg.get("defaultTargetBranch"),
        "pr": cfg.get("pr"),
        "tokenCreate": active,
        "tokenCreateUrls": {
            "gitlab": token_urls.get("gitlab"),
            "github": token_urls.get("github"),
        },
        "switchHint": 'Change "provider" to "github" when you migrate — token files are separate',
        "skill": "/wf-pr",
    },
    "instruction": (
        f"Open the create-token URL for {provider}, click Create, paste into {active_path}, then /wf-status."
    ),
}))
PY
    ;;
  *)
    echo "ERROR: unknown action $ACTION (youtrack_scaffold|youtrack_json|youtrack_token_placeholder|vcs_scaffold)" >&2
    exit 1
    ;;
esac
