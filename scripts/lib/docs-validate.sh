#!/usr/bin/env bash
# Hard-fail validate spec/plan link, branch, and task order.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
SPEC="${1:-}"
PLAN="${2:-}"

if [ -z "$SPEC" ] || [ -z "$PLAN" ]; then
  printf '{"ok":false,"errors":[{"code":"usage","message":"spec_path and plan_path required"}]}\n'
  exit 1
fi

python3 "$ROOT/scripts/lib/docs-validate.py" "$SPEC" "$PLAN" "$ROOT/scripts/lib/parse-plan-tasks.sh"
