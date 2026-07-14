#!/usr/bin/env bash
# Create merge request / pull request using workflow-toolkit vcs.json
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_shared/common.sh"

TITLE="${WF_PR_TITLE:-}"
BODY="${WF_PR_BODY:-}"
CONFIRMED="${WF_PR_CONFIRMED:-false}"
DRAFT="${WF_PR_DRAFT:-false}"
TARGET="${WF_PR_TARGET:-}"

if [ "$CONFIRMED" != "true" ]; then
  echo 'ERROR: confirmed=true required' >&2
  exit 1
fi
if [ -z "$TITLE" ]; then
  echo 'ERROR: title required' >&2
  exit 1
fi

cd "$(repo_root)" || exit 1

CFG=$(bash "$SCRIPT_DIR/vcs/config.sh" load)
export CFG TITLE BODY DRAFT TARGET
python3 <<'PY'
import json, os, subprocess, sys

cfg = json.loads(os.environ["CFG"])
if not cfg.get("ok"):
    print(json.dumps({"error": cfg.get("error", "vcs config missing")}))
    sys.exit(1)
if not cfg.get("tokenReady"):
    print(json.dumps({"error": "VCS token not ready — run /wf-init and edit token file locally"}))
    sys.exit(1)

provider = cfg["provider"]
pr = cfg.get("pr") or {}
token = open(cfg["tokenPath"], encoding="utf-8").read().strip()
title = os.environ["TITLE"]
body = os.environ.get("BODY", "")
draft = os.environ.get("DRAFT", "false").lower() == "true"
target = os.environ.get("TARGET") or cfg.get("defaultTargetBranch", "develop")
squash = pr.get("squashOnMerge", True)
remove_branch = pr.get("removeSourceBranch", True)
push = pr.get("pushBranch", True)
skip_confirm = pr.get("confirmSkip", True)

if provider == "gitlab":
    # glab non-interactive mode requires BOTH title and description flags (issue #652).
    cmd = ["glab", "mr", "create", "-t", title, "-d", body or "", "-b", target]
    if squash:
        cmd.append("--squash-before-merge")
    else:
        cmd.append("--squash-before-merge=false")
    if remove_branch:
        cmd.append("--remove-source-branch")
    else:
        cmd.append("--remove-source-branch=false")
    if draft:
        cmd.append("--draft")
    if push:
        cmd.append("--push")
    if skip_confirm:
        cmd.append("--yes")
    env = {**os.environ, "GITLAB_TOKEN": token}
elif provider == "github":
    cmd = ["gh", "pr", "create", "--title", title, "--base", target]
    if body:
        cmd.extend(["--body", body])
    if draft:
        cmd.append("--draft")
    env = {**os.environ, "GH_TOKEN": token}
else:
    print(json.dumps({"error": f"unsupported provider: {provider}"}))
    sys.exit(1)

r = subprocess.run(cmd, capture_output=True, text=True, env=env)
if r.returncode != 0:
    err = (r.stderr or r.stdout or "").strip()
    hint = None
    if provider == "gitlab" and ("409" in err or "already exists" in err.lower()):
        br = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            text=True,
            check=False,
        )
        source = (br.stdout or "").strip()
        if source:
            lr = subprocess.run(
                ["glab", "mr", "list", f"--source-branch={source}", "--output=json"],
                capture_output=True,
                text=True,
                env=env,
            )
            if lr.returncode == 0 and lr.stdout.strip():
                try:
                    mrs = json.loads(lr.stdout)
                    if mrs:
                        hint = {
                            "reason": "merge_request_already_exists",
                            "existing": mrs[0],
                            "next_step": "Use glab mr update or close the open MR before creating again",
                        }
                except json.JSONDecodeError:
                    pass
    payload = {
        "error": "create failed",
        "provider": provider,
        "stderr": err[:800],
    }
    if hint:
        payload["hint"] = hint
    print(json.dumps(payload))
    sys.exit(1)

out = (r.stdout or "").strip()
print(json.dumps({
    "ok": True,
    "provider": provider,
    "targetBranch": target,
    "squashOnMerge": squash,
    "removeSourceBranch": remove_branch,
    "output": out,
}))
PY
