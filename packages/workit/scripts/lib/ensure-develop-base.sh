#!/usr/bin/env bash
# Ensure local develop exists and matches origin/develop. Never branch from main/master.
set -euo pipefail

current=$(git branch --show-current 2>/dev/null || true)
[ -n "$current" ] || { echo 'ERROR: not in a git repository' >&2; exit 1; }

if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin develop --prune >/dev/null 2>&1 || git fetch origin --prune >/dev/null 2>&1
fi

if ! git show-ref --verify --quiet refs/remotes/origin/develop; then
  echo 'ERROR: origin/develop missing — push develop before creating feature/* or bugfix/* branches' >&2
  exit 1
fi

if git show-ref --verify --quiet refs/heads/develop; then
  git checkout develop >/dev/null 2>&1
  git merge --ff-only origin/develop >/dev/null 2>&1
else
  git checkout -b develop --track origin/develop >/dev/null 2>&1
fi
