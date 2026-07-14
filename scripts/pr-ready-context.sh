#!/bin/sh

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/_shared/common.sh"

cd "$(repo_root)" || exit 1

auto_range=false
if [ "${1:-}" != "" ]; then
  range=$1
else
  auto_range=true
  if ! resolve_pr_branch_context; then
    exit 1
  fi
  range=$PR_RANGE
fi

print_section "Repository"
printf 'root: %s\n' "$(pwd)"
printf 'branch: %s\n' "$(current_branch)"
printf 'range: %s\n' "$range"
if [ "$auto_range" = true ]; then
  printf 'base_ref: %s\n' "$PR_BASE_REF"
  printf 'merge_base: %s\n' "$PR_MERGE_BASE"
  printf 'diff_range: %s\n' "$PR_DIFF_RANGE"
  printf 'range_mode: branch-exclusive\n'
  if [ "${PR_SYNC_NOTES:-}" != "" ]; then
    printf 'git_sync: %s\n' "$PR_SYNC_NOTES"
  fi
fi

print_section "Working Tree"
git status --short 2>&1 || true

print_section "Commits"
commit_log_for_range "$range"

diff_range=$range
if [ "$auto_range" = true ]; then
  diff_range=$PR_DIFF_RANGE
fi

print_section "Diff Stat"
diff_stat_for_range "$diff_range"

print_section "Changed Files"
changed_files_for_range "$diff_range"

print_section "PR Template"
template=$(find_pr_template || true)
if [ "$template" != "" ]; then
  printf 'template_path: %s\n\n' "$template"
  sed -n '1,220p' "$template"
else
  printf 'template_path: none\n\n'
  fallback_pr_template
fi

print_section "Recent Validation Signals"
if [ -f package.json ]; then
  printf 'package.json detected. Common scripts:\n'
  node -e "const p=require('./package.json'); for (const k of ['lint','format:check','test','build']) if (p.scripts&&p.scripts[k]) console.log(k+': '+p.scripts[k])" 2>/dev/null || true
fi
if [ -f Cargo.toml ] || [ -f src-tauri/Cargo.toml ]; then
  printf 'Rust project detected.\n'
fi

print_section "VCS Config"
if bash "$SCRIPT_DIR/vcs/config.sh" summary 2>/dev/null; then
  :
else
  printf 'vcs: not configured — run /wf-init action vcs_scaffold\n'
fi

print_section "Merged PR Style"
STYLE=$(bash "$SCRIPT_DIR/vcs/merged-style.sh" 6 2>/dev/null || true)
if [ -n "$STYLE" ]; then
  printf '%s\n' "$STYLE"
else
  printf 'style_hints: Configure VCS token to load your recent merged MR/PR examples\n'
fi
