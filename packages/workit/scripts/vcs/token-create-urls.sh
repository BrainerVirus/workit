#!/usr/bin/env bash
# Build provider token-creation URLs with prefilled name, description, scopes.
set -euo pipefail

CONFIG="${WORKFLOW_VCS_CONFIG:-$HOME/.config/workflow-toolkit/vcs.json}"
TOKEN_NAME="${WORKFLOW_VCS_TOKEN_NAME:-workit}"

python3 - "$CONFIG" "$TOKEN_NAME" <<'PY'
import json, sys
from pathlib import Path
from urllib.parse import quote, urlencode

cfg_path = Path(sys.argv[1]).expanduser()
token_name = sys.argv[2]
description = "OpenCode workit — /wk-pr and glab/gh"

def load_cfg():
    if not cfg_path.is_file():
        return {}
    return json.loads(cfg_path.read_text(encoding="utf-8"))

cfg = load_cfg()
defaults = cfg.get("tokenDefaults") or {}
name = defaults.get("name") or token_name
desc = defaults.get("description") or description

gitlab = cfg.get("gitlab") or {}
host = gitlab.get("host", "gitlab.com")
gitlab_scopes = defaults.get("gitlabScopes") or ["api"]
gitlab_params = urlencode({
    "name": name,
    "description": desc,
    "scopes": ",".join(gitlab_scopes),
}, quote_via=quote)
gitlab_url = f"https://{host}/-/user_settings/personal_access_tokens?{gitlab_params}"

# Fine-grained PAT (scope prefill supported)
github_perms = defaults.get("githubPermissions") or {
    "pull_requests": "write",
    "contents": "write",
    "metadata": "read",
}
gh_params = {"name": name, "description": desc, **github_perms}
github_fine_url = (
    "https://github.com/settings/personal-access-tokens/new?"
    + urlencode(gh_params, quote_via=quote)
)

# Classic PAT (description + repo scope via legacy query — best-effort)
classic_scopes = defaults.get("githubClassicScopes") or ["repo"]
github_classic_url = (
    "https://github.com/settings/tokens/new?"
    + urlencode({"description": name, "scopes": ",".join(classic_scopes)}, quote_via=quote)
)

provider = (cfg.get("provider") or "gitlab").lower()
active = {
    "gitlab": {
        "tokenFile": (gitlab.get("tokenFile") or str(Path.home() / ".config/workflow-toolkit/gitlab.token")),
        "createUrl": gitlab_url,
        "scopes": gitlab_scopes,
        "name": name,
    },
    "github": {
        "tokenFile": ((cfg.get("github") or {}).get("tokenFile") or str(Path.home() / ".config/workflow-toolkit/github.token")),
        "createUrl": github_fine_url,
        "createUrlClassic": github_classic_url,
        "permissions": github_perms,
        "name": name,
    },
}.get(provider, {})

print(json.dumps({
    "tokenName": name,
    "tokenDescription": desc,
    "activeProvider": provider,
    "active": active,
    "gitlab": {
        "host": host,
        "createUrl": gitlab_url,
        "scopes": gitlab_scopes,
        "tokenFile": gitlab.get("tokenFile"),
    },
    "github": {
        "createUrl": github_fine_url,
        "createUrlClassic": github_classic_url,
        "permissions": github_perms,
        "tokenFile": (cfg.get("github") or {}).get("tokenFile"),
    },
}, indent=2))
PY
