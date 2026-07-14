#!/usr/bin/env bash
set -euo pipefail

TOKEN_PLACEHOLDER='YOUR_TOKEN_HERE'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CONFIG_DIR="${WORKFLOW_TOOLKIT_CONFIG:-$HOME/.config/workflow-toolkit}"
YOUTRACK_JSON="$CONFIG_DIR/youtrack.json"
YOUTRACK_TOKEN="$CONFIG_DIR/youtrack.token"
VCS_JSON="$CONFIG_DIR/vcs.json"
GITLAB_TOKEN="$CONFIG_DIR/gitlab.token"
GITHUB_TOKEN="$CONFIG_DIR/github.token"
python3 - "$CONFIG_DIR" "$YOUTRACK_JSON" "$YOUTRACK_TOKEN" "$VCS_JSON" "$GITLAB_TOKEN" "$GITHUB_TOKEN" "$PLUGIN_ROOT" "$TOKEN_PLACEHOLDER" <<'PY'
import json, os, sys
from pathlib import Path

config_dir, yt_json, yt_token, vcs_json, gl_token, gh_token, plugin_root, placeholder = sys.argv[1:9]
items = []

p = Path(yt_json)
json_abs = str(p.resolve()) if p.is_file() else str(p.expanduser().resolve())
youtrack_config = None
if p.is_file():
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
        base = (cfg.get("baseUrl") or "").rstrip("/")
        meeting = cfg.get("meetingIssue") or ""
        token_file = cfg.get("tokenFile") or ""
        meeting_issues = []
        raw_meetings = cfg.get("meetingIssues") or {}
        if isinstance(raw_meetings, dict):
            for key, item in raw_meetings.items():
                iss = item.get("issue", "")
                meeting_issues.append({
                    "key": key,
                    "issue": iss,
                    "label": item.get("label", iss),
                    "workItemText": item.get("workItemText", "Reuniones"),
                    "url": item.get("url") or (f"{base}/issue/{iss}" if base and iss else None),
                })
        youtrack_config = {
            "config_edit_path": json_abs,
            "baseUrl": base,
            "meetingIssue": meeting,
            "meetingIssues": meeting_issues,
            "meetingIssueUrl": f"{base}/issue/{meeting}" if base and meeting else None,
            "defaultMention": cfg.get("defaultMention"),
            "timezone": cfg.get("timezone"),
            "locale": cfg.get("locale"),
            "tokenFile": str(Path(token_file).expanduser().resolve()) if token_file else None,
            "tokenDefaults": cfg.get("tokenDefaults"),
            "timeLogging": {
                "meetings": {
                    "options": meeting_issues,
                    "skill": "/wf-meetings",
                    "logsTime": True,
                    "postsComment": False,
                },
                "taskWork": {
                    "issueSource": "active spec/plan **YouTrack:** field or --issue",
                    "skill": "/wf-issue-update",
                    "logsTime": True,
                    "postsComment": True,
                },
            },
        }
    except (json.JSONDecodeError, OSError):
        youtrack_config = {"config_edit_path": json_abs, "error": "invalid youtrack.json"}

items.append({
    "id": "youtrack_json",
    "label": "YouTrack config",
    "ok": p.is_file() and youtrack_config is not None and "error" not in (youtrack_config or {}),
    "path": json_abs,
    "config_edit_path": json_abs,
    "fix": "workflow_toolkit_init_apply action=youtrack_scaffold",
})

t = Path(yt_token)
token_abs = str(t.resolve()) if t.is_file() else str(t.expanduser().resolve())
token_text = t.read_text(encoding="utf-8").strip() if t.is_file() else ""
is_placeholder = token_text == placeholder or token_text.startswith(placeholder)
mode_ok = t.is_file() and oct(t.stat().st_mode)[-3:] == "600"
token_ok = mode_ok and bool(token_text) and not is_placeholder

youtrack_token_create = None
if p.is_file():
    import subprocess
    yt_urls_script = Path(plugin_root) / "scripts/youtrack/token-create-url.sh"
    if yt_urls_script.is_file():
        r = subprocess.run(
            ["bash", str(yt_urls_script)],
            capture_output=True,
            text=True,
            env={**os.environ, "WORKFLOW_YOUTRACK_CONFIG": str(p.resolve())},
        )
        if r.returncode == 0 and r.stdout.strip():
            youtrack_token_create = json.loads(r.stdout)
            if youtrack_config and "error" not in (youtrack_config or {}):
                youtrack_config["tokenCreate"] = youtrack_token_create

youtrack_token_item = {
    "id": "youtrack_token",
    "label": "YouTrack API token (mode 600, not placeholder)",
    "ok": token_ok,
    "path": token_abs,
    "token_edit_path": token_abs,
    "placeholder": is_placeholder,
    "fix": f"Open {token_abs} — replace {placeholder} with your permanent token, save, then /wf-status",
}
if youtrack_token_create:
    if youtrack_token_create.get("createUrl"):
        youtrack_token_item["token_create_url"] = youtrack_token_create["createUrl"]
    if youtrack_token_create.get("docsUrl"):
        youtrack_token_item["token_create_docs_url"] = youtrack_token_create["docsUrl"]
    if youtrack_token_create.get("scopes"):
        youtrack_token_item["token_scopes"] = youtrack_token_create["scopes"]
    if youtrack_token_create.get("tokenName"):
        youtrack_token_item["token_name"] = youtrack_token_create["tokenName"]
    if youtrack_token_create.get("steps"):
        youtrack_token_item["token_create_steps"] = youtrack_token_create["steps"]
    youtrack_token_item["token_prefill_supported"] = youtrack_token_create.get("prefillSupported", False)

items.append(youtrack_token_item)

vcs_config = None
vp = Path(vcs_json)
vcs_abs = str(vp.resolve()) if vp.is_file() else str(vp.expanduser().resolve())
if vp.is_file():
    try:
        vcfg = json.loads(vp.read_text(encoding="utf-8"))
        provider = (vcfg.get("provider") or "gitlab").lower()
        prov = vcfg.get(provider) or {}
        token_file = prov.get("tokenFile") or str(Path(config_dir) / f"{provider}.token")
        vcs_config = {
            "config_edit_path": vcs_abs,
            "provider": provider,
            "defaultTargetBranch": vcfg.get("defaultTargetBranch", "develop"),
            "pr": vcfg.get("pr") or {},
            "tokenDefaults": vcfg.get("tokenDefaults"),
            "gitlab": vcfg.get("gitlab"),
            "github": vcfg.get("github"),
            "skill": "/wf-pr",
            "switchHint": 'Set "provider" to "gitlab" or "github" in vcs.json',
        }
    except (json.JSONDecodeError, OSError):
        vcs_config = {"config_edit_path": vcs_abs, "error": "invalid vcs.json"}

items.append({
    "id": "vcs_json",
    "label": "VCS config (GitLab / GitHub)",
    "ok": vp.is_file() and vcs_config is not None and "error" not in (vcs_config or {}),
    "path": vcs_abs,
    "config_edit_path": vcs_abs,
    "fix": "workflow_toolkit_init_apply action=vcs_scaffold",
})

prov_active = (vcs_config or {}).get("provider") if vcs_config and "error" not in (vcs_config or {}) else None

token_create_urls = None
if vp.is_file():
    import subprocess
    urls_script = Path(plugin_root) / "scripts/vcs/token-create-urls.sh"
    if urls_script.is_file():
        r = subprocess.run(
            ["bash", str(urls_script)],
            capture_output=True,
            text=True,
            env={**os.environ, "WORKFLOW_VCS_CONFIG": str(vp.resolve())},
        )
        if r.returncode == 0 and r.stdout.strip():
            token_create_urls = json.loads(r.stdout)
            if vcs_config and "error" not in vcs_config:
                vcs_config["tokenCreate"] = token_create_urls.get("active")
                vcs_config["tokenCreateUrls"] = {
                    "gitlab": token_create_urls.get("gitlab"),
                    "github": token_create_urls.get("github"),
                }

def token_item(tid, label, path, provider_key):
    t = Path(path)
    abs_p = str(t.resolve()) if t.is_file() else str(t.expanduser().resolve())
    text = t.read_text(encoding="utf-8").strip() if t.is_file() else ""
    ph = text == placeholder or text.startswith(placeholder)
    mode_ok = t.is_file() and oct(t.stat().st_mode)[-3:] == "600"
    ok = mode_ok and bool(text) and not ph
    item = {
        "id": tid,
        "label": label,
        "ok": ok,
        "path": abs_p,
        "token_edit_path": abs_p,
        "placeholder": ph,
        "fix": f"Open {abs_p} — replace {placeholder}, save, then /wf-status",
        "required": prov_active == provider_key,
    }
    if token_create_urls:
        block = token_create_urls.get(provider_key) or {}
        if block.get("createUrl"):
            item["token_create_url"] = block["createUrl"]
        if block.get("createUrlClassic"):
            item["token_create_url_classic"] = block["createUrlClassic"]
        if block.get("scopes"):
            item["token_scopes"] = block["scopes"]
        if block.get("permissions"):
            item["token_permissions"] = block["permissions"]
        if block.get("name"):
            item["token_name"] = block["name"]
    return item

items.append(token_item("gitlab_token", "GitLab token (mode 600, not placeholder)", gl_token, "gitlab"))
items.append(token_item("github_token", "GitHub token (mode 600, not placeholder)", gh_token, "github"))

print(json.dumps({
    "config_dir": config_dir,
    "plugin_root": str(Path(plugin_root)),
    "token_placeholder": placeholder,
    "youtrack_config": youtrack_config,
    "vcs_config": vcs_config,
    "items": items,
    "ready": False,
}, indent=2))
PY
