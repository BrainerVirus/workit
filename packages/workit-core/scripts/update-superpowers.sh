#!/usr/bin/env bash
# Re-sync vendored Superpowers skills from upstream. Never pushes or commits.
set -euo pipefail

REPO="https://github.com/obra/superpowers.git"
VENDOR="vendor/superpowers"
PIN=""
for arg in "$@"; do
  case "$arg" in
    --https) REPO="https://github.com/obra/superpowers.git" ;;
    --ssh) REPO="git@github.com:obra/superpowers.git" ;;
    --pin=*) PIN="${arg#--pin=}" ;;
    *) if [ -z "$PIN" ]; then PIN="$arg"; fi ;;
  esac
done

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Cloning upstream..."
git clone --quiet --depth 1 "$REPO" "$STAGE/sp"
cd "$STAGE/sp"
if [ -n "$PIN" ]; then
  git fetch --quiet --depth 1 origin "refs/tags/$PIN" 2>/dev/null || {
    echo "ERROR: pin $PIN not found upstream" >&2
    exit 1
  }
  git checkout --quiet "$PIN"
fi
VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"version": "([^"]+)".*/\1/')"

cd "$ROOT"
rm -rf "$VENDOR/skills"
mkdir -p "$VENDOR"
cp -R "$STAGE/sp/skills" "$VENDOR/skills"

# Patch vendored skills to the toolkit's docs layout and contract rules.
# The upstream skills teach docs/superpowers/... and the forbidden
# "Two execution options" menu — both overridden by our contract.
find "$VENDOR/skills" -type f \( -name '*.md' -o -name '*.ts' \) -print0 | while IFS= read -r -d '' f; do
  sed -i \
    -e 's|docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md|docs/<slug>/plan.md|g' \
    -e 's|docs/superpowers/plans/<filename>.md|docs/<slug>/plan.md|g' \
    -e 's|docs/superpowers/plans/feature-plan.md|docs/<slug>/plan.md|g' \
    -e 's|docs/superpowers/plans/deployment-plan.md|docs/deployment-plan/plan.md|g' \
    -e 's|docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md|docs/<slug>/spec.md|g' \
    -e 's|docs/superpowers/specs/|docs/<slug>/|g' \
    -e 's|docs/superpowers/plans/|docs/<slug>/|g' \
    -e 's|"Plan complete and saved to `docs/<slug>/plan.md`. Two execution options:\*\*|"Plan complete and saved to `docs/<slug>/plan.md`.**|g' \
    "$f"
done

# Re-apply the per-task commit-range rule (CA-02) to the vendored
# subagent-driven-development skill after every re-sync: upstream does not
# carry it, and the hand-edit is current truth. Idempotent — when the rule is
# already present the block is a no-op, so re-running leaves one copy.
SDD_SKILL="$VENDOR/skills/subagent-driven-development/SKILL.md"
RULE="- Each task produces exactly one contiguous non-empty commit range: fix rounds append commits to it, never amend or rewrite an active review range, and the ledger progress line records the task's real base..head shas."
if [ -f "$SDD_SKILL" ] && ! grep -qF "one contiguous non-empty commit range" "$SDD_SKILL"; then
  awk -v rule="$RULE" '
    /^## Durable Progress$/ { in_section=1 }
    in_section && !inserted && /^## Prompt Templates$/ {
      print rule;
      inserted=1;
    }
    { print }
  ' "$SDD_SKILL" > "$SDD_SKILL.tmp" && mv "$SDD_SKILL.tmp" "$SDD_SKILL"
fi

printf '%s\n' "$VERSION" > "$VENDOR/VERSION"
echo "Vendored superpowers $VERSION -> $VENDOR (patched to docs/<slug>/ layout)"
echo "Review with: git status && git diff --stat"
