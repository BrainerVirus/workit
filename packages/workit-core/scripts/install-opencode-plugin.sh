#!/usr/bin/env bash
# Install OpenCode plugin: file:// pin to monorepo (or share clone) + native skill/command links.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
CORE_SCRIPTS="$ROOT/packages/workit-core/scripts"
SHARE="${HOME}/.local/share/workflow-toolkit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$ROOT}"
CONFIG="${HOME}/.config/opencode/opencode.json"

chmod +x "$CORE_SCRIPTS/sync-runtime.sh"
WORKFLOW_TOOLKIT_DEV="$ROOT" "$CORE_SCRIPTS/sync-runtime.sh"

# Prefer monorepo with .git. file:// pins skip opencode's bundled npm installer —
# git+file:// installs an EMPTY cache dir and fails silently, so the plugin never
# loads after restart. The pinned entry resolves via packages/workit-opencode/package.json main.
if [ -d "${DEV}/.git" ] && [ -f "${DEV}/packages/workit-opencode/src/plugin.ts" ]; then
  PIN="file://${DEV}/packages/workit-opencode/src/plugin.ts"
elif [ -d "${SHARE}/.git" ] && [ -f "${SHARE}/packages/workit-opencode/src/plugin.ts" ]; then
  PIN="file://${SHARE}/packages/workit-opencode/src/plugin.ts"
else
  # Last resort: ensure share is a clone, then pin it
  if [ ! -d "${SHARE}/.git" ]; then
    TMP=$(mktemp -d)
    if ! git clone --depth 1 "https://github.com/${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}.git" "$TMP"; then
      echo "FATAL: could not clone https://github.com/${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}.git" >&2
      exit 1
    fi
    rsync -a --delete --exclude node_modules --exclude cursor/mcp/node_modules "$TMP/" "$SHARE/"
    rm -rf "$TMP"
  fi
  PIN="file://${SHARE}/packages/workit-opencode/src/plugin.ts"
fi

mkdir -p "$(dirname "$CONFIG")"
[ -f "$CONFIG" ] || printf '%s\n' "{}" >"$CONFIG"

# Merge/dedupe registrations via the shared core helper (RR-06): one dev pin,
# no legacy/current duplicates, unrelated user settings preserved.
CONFIG_PATH="$CONFIG" PIN_PATH="$PIN" REGISTRATION_TS="$ROOT/packages/workit-core/src/core/registration.ts" bun -e '
import fs from "node:fs";
const { mergeOpenCodeConfig } = await import(process.env.REGISTRATION_TS!);
const path = process.env.CONFIG_PATH!;
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const { config, changed } = mergeOpenCodeConfig(data, process.env.PIN_PATH!);
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
console.log("Pinned:", process.env.PIN_PATH!);
if (changed.includes("plugin")) console.log("Deduplicated Workit plugin entries");
if (changed.includes("skills.paths")) console.log("Dropped share skill paths");
console.log("Native skills/commands via ~/.config/opencode/{skills,commands}");
'

# file:// pin already ships skills + registers /wk-* via plugin config.
# Remove leftover native links so OpenCode does not warn about duplicate skill names.
find "${HOME}/.config/opencode/skills" -maxdepth 1 -name 'wf-*' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/skill" -maxdepth 1 -name 'wf-*' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/commands" -maxdepth 1 -name 'wf-*.md' -exec rm -f {} + 2>/dev/null || true
find "${HOME}/.config/opencode/command" -maxdepth 1 -name 'wf-*.md' -exec rm -f {} + 2>/dev/null || true
rm -f "${HOME}/.config/opencode/plugins/workflow-toolkit.ts"
rm -rf "${HOME}/.cache/opencode/packages/workflow-toolkit-opencode@"* 2>/dev/null || true

# Post-install verification: file:// pins skip the installer, so a missing/empty
# pinned entry is a silent no-op. Fail loudly instead of pretending it worked.
PLUGIN_ENTRY="${PIN#file://}"
if [ ! -s "$PLUGIN_ENTRY" ]; then
  echo "FATAL: pinned plugin entry missing or empty: $PLUGIN_ENTRY" >&2
  echo "The file:// pin written to $CONFIG will not load after restart." >&2
  echo "Restore the monorepo (or fix WORKFLOW_TOOLKIT_DEV) and re-run this script." >&2
  exit 1
fi

# DG-09: verify the just-written registration with the shared offline doctor.
if ! bun "$ROOT/packages/workit-core/scripts/doctor-check.ts" opencode; then
  echo "FATAL: post-install doctor found an unhealthy OpenCode registration" >&2
  exit 1
fi

echo "OpenCode install done. Fully quit all opencode processes, then restart."
