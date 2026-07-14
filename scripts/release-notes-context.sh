#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_shared/common.sh"

cd "$(repo_root)" || exit 1

requested="${1:-}"
if [ -z "$requested" ]; then
  printf 'ERROR: release tag or range required\n' >&2
  exit 1
fi
range=$(range_arg_or_default "$requested")

print_section "Repository"
printf 'root: %s\n' "$(pwd)"
printf 'branch: %s\n' "$(current_branch)"
printf 'requested: %s\n' "${requested:-none}"
printf 'range: %s\n' "$range"

print_section "Tags"
git tag --sort=-creatordate 2>/dev/null | sed -n '1,20p' || true

print_section "Commits"
commit_log_for_range "$range"

print_section "Diff Stat"
diff_stat_for_range "$range"

print_section "Changed Files"
changed_files_for_range "$range"

print_section "Existing Release Files"
for path in CHANGELOG.md RELEASE_NOTES.md .github/releases.md; do
  if [ -f "$path" ]; then
    printf '%s\n' "$path"
  fi
done
