#!/usr/bin/env bash
# Resolve handoff branch: use-current, explicit **Branch:**, or derive feature/* / bugfix/*.
set -euo pipefail

SPEC="${1:-}"
PLAN="${2:-}"
FMT_JSON=false
[ "${3:-}" = "--format=json" ] && FMT_JSON=true

[ -n "$SPEC" ] && [ -f "$SPEC" ] || { printf 'ERROR: spec not found\n' >&2; exit 1; }
[ -n "$PLAN" ] && [ -f "$PLAN" ] || { printf 'ERROR: plan not found\n' >&2; exit 1; }

python3 - "$SPEC" "$PLAN" "$FMT_JSON" <<'PY'
import json, re, subprocess, sys
from pathlib import Path

spec = Path(sys.argv[1])
plan = Path(sys.argv[2])
fmt_json = sys.argv[3] == "true"
protected = {"main", "develop", "master", "prod", "production"}

declare_pat = re.compile(
    r"^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)/[^`\s|]+)`?\s*$",
    re.I | re.M,
)
use_current_pat = re.compile(r"^\s*\*+Branch:\*+\s*use-current\s*$", re.I | re.M)
branch_pat = re.compile(r"^(feature|bugfix)/[a-z0-9][a-z0-9._/-]*$", re.I)


def finish(branch: str, source: str) -> None:
    if fmt_json:
        print(json.dumps({"branch": branch, "source": source}))
    else:
        print(branch)
    sys.exit(0)


def normalize_branch(name: str) -> str | None:
    name = name.strip().strip("`").rstrip(".")
    if name.lower() in protected:
        return None
    if not branch_pat.match(name):
        return None
    kind, rest = name.split("/", 1)
    rest = re.sub(r"[^\w.-]+", "-", rest.lower()).strip("-")
    rest = re.sub(r"-{2,}", "-", rest)
    if not rest:
        return None
    return f"{kind.lower()}/{rest}"


for path in (spec, plan):
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8")
    if use_current_pat.search(text):
        try:
            branch = subprocess.check_output(
                ["git", "branch", "--show-current"], text=True, stderr=subprocess.DEVNULL
            ).strip()
        except subprocess.CalledProcessError:
            branch = ""
        if branch and branch_pat.match(branch):
            finish(branch, "use-current")
        print(
            "ERROR: use-current but HEAD is not feature/* or bugfix/*",
            file=sys.stderr,
        )
        sys.exit(1)

for path in (spec, plan):
    if not path.is_file():
        continue
    for m in declare_pat.finditer(path.read_text(encoding="utf-8")):
        branch = normalize_branch(m.group(1))
        if branch:
            finish(branch, "spec" if path == spec else "plan")

slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", plan.stem)
slug = re.sub(r"-design$", "", slug, flags=re.I)
slug = re.sub(r"[^\w.-]+", "-", slug.lower()).strip("-")
slug = re.sub(r"-{2,}", "-", slug)

goal = ""
for line in plan.read_text(encoding="utf-8").splitlines():
    if line.startswith("**Goal:**"):
        goal = line.lower()
        break

kind = "feature"
if re.search(r"\bbugfix\b", slug, re.I) or re.match(r"fix-", slug, re.I):
    kind = "bugfix"
elif goal and re.search(r"\b(bugfix|bug fix)\b", goal) and not re.search(
    r"\b(feat|feature|upgrade|add)\b", goal
):
    kind = "bugfix"

if not slug:
    print(f"ERROR: cannot derive branch slug from plan {plan}", file=sys.stderr)
    sys.exit(1)

finish(f"{kind}/{slug}", "derived")
PY
