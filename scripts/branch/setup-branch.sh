#!/usr/bin/env bash
# In-place branch checkout for feature/* or bugfix/* — NO worktrees.
set -euo pipefail

ACTION="${1:-setup}"
SDD_DIR="${2:-}"
TARGET="${3:-}"
STASH="${4:-no}"

PROTECTED='^(main|master|develop|prod|production)$'
BRANCH_OK='^(feature|bugfix)/.+'

current=$(git branch --show-current 2>/dev/null || true)
[ -n "$current" ] || { echo 'ERROR: not in a git repository' >&2; exit 1; }

[ -n "$SDD_DIR" ] || SDD_DIR="docs/superpowers/sdd"
MANIFEST="$SDD_DIR/manifest.json"
mkdir -p "$SDD_DIR"

if [ "$ACTION" = "reapply_stash" ]; then
  ref=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('stash_ref',''))" 2>/dev/null || true)
  [ -n "$ref" ] || { echo 'ERROR: no stash_ref in manifest' >&2; exit 1; }
  git stash pop "$ref"
  python3 - "$MANIFEST" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
d.pop("stash_ref", None)
d.pop("stash_created_at", None)
p.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
PY
  python3 -c "import json; print(json.dumps({'action':'reapply_stash','ok':True}))"
  exit 0
fi

[ -n "$TARGET" ] || { echo 'ERROR: target branch required' >&2; exit 1; }
[[ "$TARGET" =~ $PROTECTED ]] && { echo "ERROR: protected branch $TARGET" >&2; exit 1; }
[[ "$TARGET" =~ $BRANCH_OK ]] || { echo "ERROR: target must be feature/* or bugfix/* — got $TARGET" >&2; exit 1; }

stash_ref=""
if [ "$current" != "$TARGET" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    [ "$STASH" = "yes" ] || {
      echo 'ERROR: dirty working tree — ask with native AskQuestion, then call workflow_branch_setup with stash=yes' >&2
      exit 1
    }
    git stash push -u -m "workflow-toolkit: pre-checkout $TARGET"
    stash_ref="stash@{0}"
  fi
  if git show-ref --verify --quiet "refs/heads/$TARGET"; then
    checkout_err=$(mktemp)
    if ! git checkout "$TARGET" 2>"$checkout_err"; then
      if grep -qi worktree <<<"$(cat "$checkout_err" 2>/dev/null)"; then
        echo "ERROR: branch $TARGET is locked by an existing git worktree — remove it first (we do not use worktrees):" >&2
        git worktree list >&2 || true
        echo "Fix: git worktree remove <path>  # then re-run workflow_branch_setup" >&2
        exit 1
      fi
      cat "$checkout_err" >&2
      rm -f "$checkout_err"
      exit 1
    fi
    rm -f "$checkout_err"
  else
    git checkout -b "$TARGET"
  fi
fi

python3 - "$MANIFEST" "$TARGET" "$stash_ref" "$current" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path

manifest, branch, stash, previous = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
data = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {}
data["branch"] = branch
data["previous_branch"] = previous
if stash:
    data["stash_ref"] = stash
    data["stash_created_at"] = datetime.now(timezone.utc).astimezone().isoformat()
print(json.dumps({
    "action": "setup",
    "ok": True,
    "branch": branch,
    "previous_branch": previous,
    "stash_ref": stash or None,
    "manifest": str(manifest),
}))
manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
