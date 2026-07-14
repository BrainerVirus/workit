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

print_section "Keep a Changelog Rules"
cat <<'RULES'
- Use an [Unreleased] section.
- Use Added, Changed, Deprecated, Removed, Fixed, Security.
- Entries should be human-readable and user-facing.
- Do not use raw commit messages as changelog bullets.
- MERGE into existing ### Category under [Unreleased] — never append a second ### Added / ### Fixed block.
- Apply with MCP workflow_changelog_apply only (not hand-edits under Unreleased).
- If Unreleased already has duplicate category headings, normalize_only first.
RULES

print_section "Existing CHANGELOG.md"
if [ -f CHANGELOG.md ]; then
  sed -n '1,260p' CHANGELOG.md
else
  printf 'CHANGELOG.md not found.\n'
fi

print_section "Commits"
commit_log_for_range "$range"

print_section "Diff Stat"
diff_stat_for_range "$range"

print_section "Changed Files"
changed_files_for_range "$range"
