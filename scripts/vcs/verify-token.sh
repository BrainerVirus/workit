#!/usr/bin/env bash
# Read-only VCS token check (GitLab or GitHub).
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CFG_JSON=$(bash "$SCRIPT_DIR/config.sh" load 2>/dev/null || echo '{"ok":false}')

python3 - "$CFG_JSON" <<'PY'
import json, os, subprocess, sys

cfg = json.loads(sys.argv[1])
if not cfg.get("ok"):
    print(json.dumps({"ok": False, "error": cfg.get("error", "vcs config not ready")}))
    sys.exit(0)

provider = cfg.get("provider", "gitlab")
token_path = cfg.get("tokenPath")
if not cfg.get("tokenReady"):
    print(json.dumps({
        "ok": False,
        "provider": provider,
        "error": "token file still placeholder YOUR_TOKEN_HERE — edit locally, then /wf-status",
        "path": token_path,
    }))
    sys.exit(0)

token = open(token_path, encoding="utf-8").read().strip()

if provider == "gitlab":
    host = (cfg.get("gitlab") or {}).get("host", "gitlab.com")
    api = (cfg.get("gitlab") or {}).get("apiUrl", f"https://{host}/api/v4")
    url = f"{api.rstrip('/')}/user"
    r = subprocess.run(
        ["curl", "-fsS", "-H", f"PRIVATE-TOKEN: {token}", url],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(json.dumps({"ok": False, "provider": provider, "error": "GitLab API rejected token", "detail": (r.stderr or r.stdout)[:200]}))
        sys.exit(0)
    user = json.loads(r.stdout)
    print(json.dumps({
        "ok": True,
        "provider": provider,
        "username": user.get("username") or user.get("login"),
        "name": user.get("name"),
    }))
elif provider == "github":
    env = {**os.environ, "GH_TOKEN": token}
    r = subprocess.run(["gh", "api", "user"], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print(json.dumps({"ok": False, "provider": provider, "error": "GitHub API rejected token", "detail": (r.stderr or r.stdout)[:200]}))
        sys.exit(0)
    user = json.loads(r.stdout)
    print(json.dumps({
        "ok": True,
        "provider": provider,
        "username": user.get("login"),
        "name": user.get("name"),
    }))
else:
    print(json.dumps({"ok": False, "error": f"unsupported provider: {provider}"}))
PY
