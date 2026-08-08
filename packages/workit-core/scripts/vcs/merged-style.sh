#!/usr/bin/env bash
# Recent merged MR/PR bodies for wk-pr style reference (current user).
set -euo pipefail

LIMIT="${1:-6}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

. "$PLUGIN_ROOT/scripts/_shared/common.sh" 2>/dev/null || true

cd "$(repo_root 2>/dev/null || pwd)" || exit 0

CFG=$(bash "$SCRIPT_DIR/config.sh" load 2>/dev/null) || CFG='{"ok":false}'
export CFG LIMIT
python3 <<'PY'
import json, os, subprocess, sys

cfg = json.loads(os.environ["CFG"])
limit = int(os.environ.get("LIMIT", "6"))
if not cfg.get("ok") or not cfg.get("tokenReady"):
    print(json.dumps({"ok": False, "error": "vcs not configured"}))
    sys.exit(0)

provider = cfg.get("provider")
token_path = cfg["tokenPath"]
token = open(token_path, encoding="utf-8").read().strip()
examples = []

if provider == "gitlab":
    remote = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    if remote.returncode != 0:
        print(json.dumps({"ok": False, "error": "no origin remote"}))
        sys.exit(0)
    url = remote.stdout.strip()
    # git@gitlab.com:group/project.git or https://...
    import re
    m = re.search(r"gitlab\.com[:/](.+?)(?:\.git)?$", url)
    if not m:
        print(json.dumps({"ok": False, "error": "not a gitlab.com origin"}))
        sys.exit(0)
    project = m.group(1)
    enc = project.replace("/", "%2F")
    env = {**os.environ, "GITLAB_TOKEN": token}
    r = subprocess.run(
        ["glab", "api", f"projects/{enc}/merge_requests?state=merged&per_page={limit}&order_by=updated_at&sort=desc"],
        capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        # fallback: author-wide recent merged
        r = subprocess.run(
            ["glab", "api", f"merge_requests?state=merged&per_page={limit}&order_by=updated_at&sort=desc"],
            capture_output=True, text=True, env=env,
        )
    if r.returncode != 0:
        print(json.dumps({"ok": False, "error": "could not list merge requests"}))
        sys.exit(0)
    for mr in json.loads(r.stdout):
        desc = (mr.get("description") or "").strip()
        examples.append({
            "title": mr.get("title"),
            "url": mr.get("web_url"),
            "squash": mr.get("squash"),
            "hasNotesSection": "## Notes" in desc or "## notes" in desc.lower(),
            "sections": [ln.strip() for ln in desc.splitlines() if ln.startswith("## ")],
            "descriptionPreview": desc[:600],
        })
elif provider == "github":
    env = {**os.environ, "GH_TOKEN": token}
    r = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--limit", str(limit), "--json", "title,url,body"],
        capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        print(json.dumps({"ok": False, "error": "could not list pull requests"}))
        sys.exit(0)
    for pr in json.loads(r.stdout):
        desc = (pr.get("body") or "").strip()
        examples.append({
            "title": pr.get("title"),
            "url": pr.get("url"),
            "hasNotesSection": "## Notes" in desc,
            "sections": [ln.strip() for ln in desc.splitlines() if ln.startswith("## ")],
            "descriptionPreview": desc[:600],
        })

print(json.dumps({
    "ok": True,
    "provider": provider,
    "count": len(examples),
    "styleHints": [
        "Prefer ## Summary bullets + ## Validation or ## Test plan only",
        "Do not add ## Notes with branch names, commit counts, or diff stats",
        "Do not paste commit log or diff stat into the body",
    ],
    "examples": examples,
}, indent=2))
PY
