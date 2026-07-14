#!/bin/sh

set -u

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown'
}

default_base() {
  for ref in origin/main main origin/master master origin/develop develop; do
    if git rev-parse --verify "$ref" >/dev/null 2>&1; then
      printf '%s\n' "$ref"
      return 0
    fi
  done
  printf 'HEAD~1\n'
}

range_arg_or_default() {
  if [ "${1:-}" != "" ]; then
    printf '%s\n' "$1"
  else
    base=$(default_base)
    printf '%s...HEAD\n' "$base"
  fi
}

pr_range_arg_or_default() {
  if [ "${1:-}" != "" ]; then
    printf '%s\n' "$1"
    return 0
  fi
  resolve_pr_range
}

is_protected_branch() {
  branch=$1
  case "$branch" in
    main|master|develop|prod|production) return 0 ;;
    *) return 1 ;;
  esac
}

is_pr_branch() {
  branch=$1
  case "$branch" in
    feature/*|bugfix/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ponytail: fetch + ff-only — never merge/rebase; warns and continues on failure
sync_pr_refs() {
  branch=$(current_branch)
  notes=""

  if git fetch --prune >/dev/null 2>&1; then
    notes="fetch: ok"
  else
    printf 'WARN: git fetch failed — using local refs only\n' >&2
    PR_SYNC_NOTES="fetch: failed"
    export PR_SYNC_NOTES
    return 0
  fi

  upstream=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null) || upstream=""
  if [ -n "$upstream" ]; then
    if git pull --ff-only >/dev/null 2>&1; then
      notes="fetch: ok; branch($branch): ff-only from $upstream"
    else
      printf 'WARN: could not fast-forward %s from %s\n' "$branch" "$upstream" >&2
      notes="fetch: ok; branch($branch): pull skipped"
    fi
  else
    notes="fetch: ok; branch($branch): no upstream"
  fi

  if git show-ref --verify --quiet refs/heads/develop \
    && git show-ref --verify --quiet refs/remotes/origin/develop; then
    if git fetch origin develop:develop >/dev/null 2>&1; then
      notes="$notes; develop: ff from origin/develop"
    else
      notes="$notes; develop: local update skipped"
    fi
  elif git show-ref --verify --quiet refs/remotes/origin/develop; then
    notes="$notes; develop: origin/develop fetched"
  fi

  PR_SYNC_NOTES=$notes
  export PR_SYNC_NOTES
}

# ponytail: develop-only base — main is release-only in this workflow; never compare PRs to main
resolve_pr_branch_context() {
  branch=$(current_branch)

  if is_protected_branch "$branch"; then
    printf 'ERROR: cannot build PR context on protected branch %s — PRs are for feature/* or bugfix/* only\n' "$branch" >&2
    return 1
  fi

  if ! is_pr_branch "$branch"; then
    if [ "$branch" = "unknown" ]; then
      printf 'ERROR: not in a git repository at %s — pass workspace_root to the MCP tool or open the target repo as the Cursor workspace\n' "$(pwd)" >&2
    else
      printf 'ERROR: branch %s is not feature/* or bugfix/* — checkout a feature branch or pass an explicit git range\n' "$branch" >&2
    fi
    return 1
  fi

  best_ref=""
  best_mb=""

  for ref in origin/develop develop; do
    git rev-parse --verify "$ref" >/dev/null 2>&1 || continue
    mb=$(git merge-base "$ref" HEAD 2>/dev/null) || continue
    best_ref=$ref
    best_mb=$mb
    break
  done

  if [ "$best_ref" = "" ] || [ "$best_mb" = "" ]; then
    printf 'ERROR: develop branch not found — PRs target develop (not main). Fetch/checkout develop or pass an explicit git range\n' >&2
    return 1
  fi

  sync_pr_refs

  mb=$(git merge-base "$best_ref" HEAD 2>/dev/null) || {
    printf 'ERROR: cannot compute merge base for %s and HEAD after sync\n' "$best_ref" >&2
    return 1
  }
  best_mb=$mb

  PR_BASE_REF=$best_ref
  PR_MERGE_BASE=$best_mb
  PR_RANGE="${best_ref}..HEAD"
  PR_DIFF_RANGE="${best_mb}..HEAD"
  export PR_BASE_REF PR_MERGE_BASE PR_RANGE PR_DIFF_RANGE PR_SYNC_NOTES
  return 0
}

resolve_pr_range() {
  if ! resolve_pr_branch_context; then
    return 1
  fi
  printf '%s\n' "$PR_RANGE"
}

print_section() {
  printf '\n## %s\n\n' "$1"
}

run_or_note() {
  label=$1
  shift
  print_section "$label"
  "$@" 2>&1 || printf '[command failed: %s]\n' "$*"
}

find_pr_template() {
  for path in \
    .gitlab/merge_request_templates/Default.md \
    .gitlab/merge_request_templates/default.md \
    .gitlab/merge_request_templates/merge_request_template.md \
    .github/PULL_REQUEST_TEMPLATE.md \
    .github/pull_request_template.md \
    .github/PULL_REQUEST_TEMPLATE/pull_request_template.md \
    docs/PULL_REQUEST_TEMPLATE.md \
    PULL_REQUEST_TEMPLATE.md
  do
    if [ -f "$path" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

fallback_pr_template() {
  cat <<'TEMPLATE'
## Summary
-

## Validation
- [ ] Not run
TEMPLATE
}

changed_files_for_range() {
  range=$1
  git diff --name-only "$range" 2>/dev/null || git diff --name-only 2>/dev/null || true
}

commit_log_for_range() {
  range=$1
  git log --oneline --decorate --no-merges "$range" 2>/dev/null || git log --oneline --decorate -10 2>/dev/null || true
}

diff_stat_for_range() {
  range=$1
  git diff --stat "$range" 2>/dev/null || git diff --stat 2>/dev/null || true
}
