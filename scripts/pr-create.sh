#!/usr/bin/env bash
# Create merge request / pull request using workflow-toolkit vcs.json
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_shared/common.sh"

MODE="${1:-create}"

if [ "$MODE" = "--build-body" ]; then
  MODE=build-body
else
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
fi
export MODE
python3 <<'PY'
import json, os, re, shutil, subprocess, sys
from pathlib import Path

def parse_gh_repo(remote: str) -> str | None:
    remote = (remote or "").strip().rstrip("/")
    if not remote:
        return None
    if remote.endswith(".git"):
        remote = remote[:-4]
    if ":" in remote:
        remote = remote.split(":", 1)[-1]  # drop git@host part (scp-style URL)
    parts = [p for p in remote.split("/") if p]
    return "/".join(parts[-2:]) if len(parts) >= 2 else None


def build_body(body, branch, link_issues, base_url, yt_issue, gh_link_on_pr, gh_issue, gh_relation, gh_repo):
    line = None
    if link_issues:
        issue = yt_issue
        if not issue and branch:
            # Review M-2: anchored prefix + \b boundary, 3+ digits so version-like
            # tokens (POSTGRES-16, HTTP-3) never link; IRP-123-style ids do.
            m = re.search(r"(?:^|/|-)([A-Z]{2,}-\d{3,})\b", branch)
            if m:
                issue = m.group(1)
        if issue and base_url:
            line = f"Related to: {base_url.rstrip('/')}/issue/{issue}"
    elif gh_link_on_pr:
        issue = gh_issue.strip().lstrip("#")
        if not issue and branch:
            # pure-number issue id (feature/42-title -> 42); digits must be followed by a dash or
            # end-of-string so version tokens (release/1.2.3, backport/8.0.1, lodash-4.17.21, 2024.1) never link
            m = re.search(r"(?:^|/|-)(\d+)(?:-|$)", branch)
            if m:
                issue = m.group(1)
        if issue:
            if gh_relation == "related":
                line = f"Related to #{issue}"
                if gh_repo:
                    line += f" — https://github.com/{gh_repo}/issues/{issue}"
            else:
                line = f"Closes #{issue}"
    if line is None:
        return body
    return f"{body}\n\n{line}" if body else line

mode = os.environ.get("MODE", "create")
if mode == "build-body":
    gh_link_on_pr = os.environ.get("GH_LINK_ON_PR", "").lower() in ("1", "true", "yes")
    gh_repo = os.environ.get("GH_REPO", "")
    if not gh_repo and gh_link_on_pr:
        rr = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=False)
        gh_repo = parse_gh_repo(rr.stdout) if rr.returncode == 0 else None
    print(json.dumps({"body": build_body(
        os.environ.get("BODY", ""),
        os.environ.get("BRANCH", ""),
        os.environ.get("LINK_ISSUES", "").lower() in ("1", "true", "yes"),
        os.environ.get("YT_BASE_URL", ""),
        os.environ.get("WORKFLOW_YT_ISSUE", ""),
        gh_link_on_pr,
        os.environ.get("WORKFLOW_GH_ISSUE", ""),
        os.environ.get("WORKFLOW_GH_ISSUE_RELATION", "closes"),
        gh_repo,
    )}))
    sys.exit(0)

cfg = json.loads(os.environ["CFG"])
if not cfg.get("ok"):
    print(json.dumps({"error": cfg.get("error", "vcs config missing")}))
    sys.exit(1)
if not cfg.get("tokenReady"):
    print(json.dumps({"error": "VCS token not ready — run /wf-init and edit token file locally"}))
    sys.exit(1)

provider = cfg["provider"]
if provider not in ("gitlab", "github"):
    print(json.dumps({"error": f"unsupported provider: {provider}"}))
    sys.exit(1)
cli = "glab" if provider == "gitlab" else "gh"
install_url = "https://gitlab.com/gitlab-org/cli" if provider == "gitlab" else "https://cli.github.com"
if shutil.which(cli) is None:
    print(json.dumps({
        "ok": False,
        "cli_missing": True,
        "error": f"workflow CLI missing: {cli} (required for {provider}). Install: {install_url}",
        "install_url": install_url,
    }))
    sys.exit(1)
pr = cfg.get("pr") or {}
token = open(cfg["tokenPath"], encoding="utf-8").read().strip()
title = os.environ["TITLE"]
body = os.environ.get("BODY", "")
draft = os.environ.get("DRAFT", "false").lower() == "true"
target = os.environ.get("TARGET") or cfg.get("defaultTargetBranch", "develop")

br = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True, check=False)
branch = (br.stdout or "").strip() if br.returncode == 0 else ""
base_url = cfg.get("youtrack_base_url")
if not base_url:
    yt_cfg = os.environ.get("WORKFLOW_YOUTRACK_CONFIG") or str(Path(cfg.get("configPath", "")).parent / "youtrack.json")
    try:
        yt = json.loads(Path(yt_cfg).read_text(encoding="utf-8"))
        if isinstance(yt, dict):
            base_url = yt.get("baseUrl")
    except Exception:
        pass
gh_link_on_pr = cfg.get("issues_provider") == "github" and cfg.get("link_on_pr") is True
gh_repo = None
if gh_link_on_pr:
    rr = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, check=False)
    gh_repo = parse_gh_repo(rr.stdout) if rr.returncode == 0 else None
body = build_body(
    body, branch, cfg.get("link_issues") is True, base_url, os.environ.get("WORKFLOW_YT_ISSUE", ""),
    gh_link_on_pr, os.environ.get("WORKFLOW_GH_ISSUE", ""), os.environ.get("WORKFLOW_GH_ISSUE_RELATION", "closes"), gh_repo,
)
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

r = subprocess.run(cmd, capture_output=True, text=True, env=env)
if r.returncode != 0:
    err = (r.stderr or r.stdout or "").strip()
    hint = None
    if provider == "gitlab" and ("409" in err or "already exists" in err.lower()):
        source = branch
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
