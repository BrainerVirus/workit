#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PARSER="$PLUGIN_ROOT/scripts/lib/parse-plan-tasks.sh"
TEMPLATE="$PLUGIN_ROOT/templates/execution-contract.md"

MESSAGE="${*:-}"
SPECS_DIR="docs/superpowers/specs"
PLANS_DIR="docs/superpowers/plans"

list_md() {
  find "$1" -maxdepth 1 -name '*.md' 2>/dev/null | sort
}

extract_message_paths() {
  printf '%s\n' "$MESSAGE" | grep -oE 'docs/(superpowers/)?(specs|plans)/[^[:space:]`'"'"']+\.md' || true
}

list_candidates() {
  local s p
  for s in $(list_md "$SPECS_DIR"); do printf 'SPEC: %s\n' "$s" >&2; done
  for p in $(list_md "$PLANS_DIR"); do printf 'PLAN: %s\n' "$p" >&2; done
}

resolve_from_message_paths() {
  local -a paths msg_specs msg_plans
  mapfile -t paths < <(extract_message_paths | sort -u)

  msg_specs=()
  msg_plans=()
  for p in "${paths[@]}"; do
    [ -n "$p" ] || continue
    case "$p" in
      docs/superpowers/specs/*|docs/specs/*) msg_specs+=("$(normalize_doc_path "$p")") ;;
      docs/superpowers/plans/*) msg_plans+=("$p") ;;
    esac
  done

  local sc=${#msg_specs[@]} pc=${#msg_plans[@]}
  if [ "$sc" -eq 0 ] && [ "$pc" -eq 0 ]; then
    return 2
  fi
  if [ "$sc" -eq 1 ] && [ "$pc" -eq 1 ]; then
    SPEC="${msg_specs[0]}"
    PLAN="${msg_plans[0]}"
    printf 'RESOLVE=message_paths\n' >&2
    return 0
  fi

  printf 'ERROR: multiple specs or plans in message — use exactly one of each\n' >&2
  local s p
  for s in "${msg_specs[@]}"; do printf 'SPEC: %s\n' "$s" >&2; done
  for p in "${msg_plans[@]}"; do printf 'PLAN: %s\n' "$p" >&2; done
  return 1
}

# ponytail: newest linked or basename-matched pair — upgrade path is explicit paths in message
resolve_active_pair() {
  local resolved
  resolved=$(SPECS_DIR="$SPECS_DIR" PLANS_DIR="$PLANS_DIR" python3 <<'PY'
import glob, os, re, sys

specs_dir = os.environ["SPECS_DIR"]
plans_dir = os.environ["PLANS_DIR"]
spec_pat = re.compile(r"docs/(?:superpowers/)?specs/[^\s`]+\.md")

best = None
for plan in sorted(glob.glob(os.path.join(plans_dir, "*.md"))):
    spec = None
    source = "active_pair"
    with open(plan, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("**Spec:**"):
                m = spec_pat.search(line)
                if m:
                    spec = m.group(0)
                break
    if spec and spec.startswith("docs/specs/"):
        alt = os.path.join("docs/superpowers/specs", os.path.basename(spec))
        if os.path.isfile(alt):
            spec = alt
    if spec is None:
        stem = os.path.splitext(os.path.basename(plan))[0]
        for name in (f"{stem}-design.md", f"{stem}.md"):
            candidate = os.path.join(specs_dir, name)
            if os.path.isfile(candidate):
                spec = candidate
                source = "matching_pair"
                break
    if not spec or not os.path.isfile(spec):
        continue
    score = max(os.path.getmtime(spec), os.path.getmtime(plan))
    if (best is None or score > best[0] or
            (score == best[0] and (spec, plan) < (best[1], best[2]))):
        best = (score, spec, plan, source)

if best is None:
    sys.exit(2)
print(best[1])
print(best[2])
print(best[3])
PY
) || return $?

  SPEC=$(printf '%s\n' "$resolved" | sed -n '1p')
  PLAN=$(printf '%s\n' "$resolved" | sed -n '2p')
  local source
  source=$(printf '%s\n' "$resolved" | sed -n '3p')
  [ -n "$SPEC" ] && [ -n "$PLAN" ] && [ -f "$SPEC" ] && [ -f "$PLAN" ] || return 2
  printf 'RESOLVE=%s spec=%s plan=%s\n' "$source" "$SPEC" "$PLAN" >&2
  return 0
}

normalize_doc_path() {
  local p="$1"
  case "$p" in
    docs/specs/*)
      local alt="docs/superpowers/specs/$(basename -- "$p")"
      if [ -f "$alt" ]; then
        printf '%s' "$alt"
        return 0
      fi
      ;;
  esac
  if [ -f "$p" ]; then
    printf '%s' "$p"
    return 0
  fi
  printf '%s' "$p"
}

resolve_paths() {
  local rc=0
  resolve_from_message_paths && return 0
  rc=$?
  [ "$rc" -eq 1 ] && return 1

  resolve_active_pair && return 0
  rc=$?
  [ "$rc" -eq 1 ] && return 1

  if [ ! -d "$SPECS_DIR" ] || [ -z "$(list_md "$SPECS_DIR")" ]; then
    printf 'ERROR: no spec under docs/superpowers/specs/\n' >&2
    return 1
  fi
  if [ ! -d "$PLANS_DIR" ] || [ -z "$(list_md "$PLANS_DIR")" ]; then
    printf 'ERROR: no plan under docs/superpowers/plans/\n' >&2
    return 1
  fi

  printf 'ERROR: could not resolve spec and plan for this thread\n' >&2
  printf 'Hint: mention paths, add a **Spec:** link, or use matching <slug>.md and <slug>-design.md names\n' >&2
  list_candidates
  return 1
}

resolve_paths

[ -f "$TEMPLATE" ] || { printf 'ERROR: missing template %s\n' "$TEMPLATE" >&2; exit 1; }

BRANCH=$(bash "$PLUGIN_ROOT/scripts/lib/resolve-handoff-branch.sh" "$SPEC" "$PLAN")
SLUG=$(basename "$PLAN" .md)
SDD_DIR="docs/superpowers/sdd/${SLUG}"
printf 'BRANCH=%s\n' "$BRANCH" >&2
printf 'SDD_DIR=%s\n' "$SDD_DIR" >&2

TASK_LIST=$("$PARSER" "$PLAN" 2>/dev/null) || {
  printf 'ERROR: failed to parse plan %s\n' "$PLAN" >&2
  exit 1
}
TASK_COUNT=$(printf '%s\n' "$TASK_LIST" | grep -c '^- Task ' || true)
printf 'TASK_COUNT=%s\n' "$TASK_COUNT" >&2

CONTRACT=$(printf '%s' "$TASK_LIST" | python3 -c '
import sys
from pathlib import Path
template_path, spec, plan, branch, slug, sdd_dir = sys.argv[1:7]
task_list = sys.stdin.read()
text = Path(template_path).read_text()
text = (
    text.replace("<SPEC_PATH>", spec)
    .replace("<PLAN_PATH>", plan)
    .replace("<BRANCH>", branch)
    .replace("<SLUG>", slug)
    .replace("<SDD_DIR>", sdd_dir)
    .replace("<TASK_LIST>", task_list)
)
print(text, end="")
' "$TEMPLATE" "$SPEC" "$PLAN" "$BRANCH" "$SLUG" "$SDD_DIR")

printf 'PROMPT_START\n%s\nPROMPT_END\n' "$CONTRACT"
