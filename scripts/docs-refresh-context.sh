#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_shared/common.sh"

cd "$(repo_root)" || exit 1

range=$(range_arg_or_default "${1:-}")

print_section "Repository"
printf 'root: %s\n' "$(pwd)"
printf 'branch: %s\n' "$(current_branch)"
printf 'range: %s\n' "$range"

print_section "Changed Files"
changed_files_for_range "$range"

print_section "Documentation Files"
find . -maxdepth 3 \( -name 'README.md' -o -name '*.md' \) \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path './target/*' \
  -not -path './dist/*' \
  | sort | sed -n '1,200p'

print_section "README Preview"
if [ -f README.md ]; then
  sed -n '1,220p' README.md
else
  printf 'README.md not found.\n'
fi

print_section "Package Scripts"
if [ -f package.json ]; then
  node -e "const p=require('./package.json'); console.log(JSON.stringify({name:p.name,version:p.version,scripts:p.scripts}, null, 2))" 2>/dev/null || true
else
  printf 'package.json not found.\n'
fi
