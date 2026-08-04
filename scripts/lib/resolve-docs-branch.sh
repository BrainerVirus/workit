#!/usr/bin/env bash
# Branch choice for spec/plan authors: keep HEAD feature|bugfix or create from develop.
set -euo pipefail

PLAN="${1:-}"
KIND="${2:-feature}"

python3 - "$PLAN" "$KIND" <<'PY'
import json, re, subprocess, sys
from pathlib import Path

plan_arg, kind_arg = sys.argv[1], sys.argv[2].lower()
branch_pat = re.compile(r"^(feature|bugfix)/[a-z0-9][a-z0-9._/-]*$", re.I)

try:
    head = subprocess.check_output(
        ["git", "branch", "--show-current"], text=True, stderr=subprocess.DEVNULL
    ).strip()
except subprocess.CalledProcessError:
    head = ""

if head and branch_pat.match(head):
    print(json.dumps({
        "branch": head,
        "action": "keep",
        "current_branch": head,
        "base": "develop",
    }))
    raise SystemExit(0)

if head in {"main", "master", "develop"}:
    slug = ""
    if plan_arg and Path(plan_arg).is_file():
        stem = Path(plan_arg).stem
        slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", stem)
        slug = re.sub(r"-design$", "", slug, flags=re.I)
        slug = re.sub(r"[^\w.-]+", "-", slug.lower()).strip("-")
        slug = re.sub(r"-{2,}", "-", slug)
    if not slug:
        print(json.dumps({"error": "plan_path required to derive branch slug when not on feature/* or bugfix/*"}))
        raise SystemExit(1)
    kind = "bugfix" if kind_arg == "bugfix" else "feature"
    print(json.dumps({
        "branch": f"{kind}/{slug}",
        "action": "create_from_develop",
        "current_branch": head,
        "base": "develop",
    }))
    raise SystemExit(0)

print(json.dumps({"error": f"cannot resolve docs branch from HEAD {head!r}"}))
raise SystemExit(1)
PY
