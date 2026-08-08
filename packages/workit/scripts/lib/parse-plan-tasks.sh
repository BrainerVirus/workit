#!/usr/bin/env bash
set -euo pipefail

PLAN="${1:-}"
FORMAT="lines"
[ "${2:-}" = "--format=json" ] && FORMAT="json"
[ -n "$PLAN" ] && [ -f "$PLAN" ] || { printf 'ERROR: plan file not found\n' >&2; exit 1; }

# ponytail: bash line scan splits on ### Task N — upgrade path is more sections in plan format only
mapfile -t lines < "$PLAN"
ids=(); titles=(); bodies=()
current_id=""; current_title=""; body=""

flush() {
  [ -n "$current_id" ] || return 0
  ids+=("$current_id")
  titles+=("$current_title")
  bodies+=("$body")
  body=""
}

in_fence=0

for line in "${lines[@]}"; do
  if [[ "$line" =~ ^\`\`\` ]]; then
    in_fence=$((1 - in_fence))
    continue
  fi
  [ "$in_fence" -eq 1 ] && continue

  if [[ "$line" =~ ^###[[:space:]]Task[[:space:]]+([0-9]+):[[:space:]]*(.*)$ ]]; then
    flush
    current_id="${BASH_REMATCH[1]}"
    current_title="${BASH_REMATCH[2]}"
    body=""
  elif [ -n "$current_id" ]; then
    body+="$line"$'\n'
  fi
done
flush

count=${#ids[@]}
if [ "$count" -eq 0 ]; then
  printf 'ERROR: no ### Task N sections found — plan must follow writing-plans format\n' >&2
  exit 1
fi

if [ "$FORMAT" = "json" ]; then
  printf '{ "task_count": %s, "tasks": [' "$count"
  for i in "${!ids[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    id="${ids[$i]}"
    title="${titles[$i]}"
    section="${bodies[$i]}"
    section_escaped=$(printf '%s' "$section" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    title_escaped=$(printf '%s' "$title" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    printf '{ "id": %s, "title": %s, "section_text": %s }' "$id" "$title_escaped" "$section_escaped"
  done
  printf ']}\n'
else
  for i in "${!ids[@]}"; do
    printf -- '- Task %s: %s\n' "${ids[$i]}" "${titles[$i]}"
  done
fi
