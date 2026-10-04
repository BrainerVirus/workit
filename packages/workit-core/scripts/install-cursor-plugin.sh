#!/usr/bin/env bash
# Install / refresh Cursor plugin (+ OpenCode live loader via sync-runtime).
set -euo pipefail

REPO_SLUG="${WORKFLOW_TOOLKIT_REPO:-BrainerVirus/workit}"
SHARE="${HOME}/.local/share/workit"
SKILLS_DIR="${HOME}/.cursor/skills"

FROM_GITHUB=0
LOCAL_DIST=0
LOCAL_ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  # RR-05: LOCAL_ROOT is the checkout root (scripts live under <root>/packages/workit-core/scripts)
  LOCAL_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
else
  FROM_GITHUB=1
fi

for arg in "$@"; do
  case "$arg" in
    --github|--from-github) FROM_GITHUB=1 ;;
    --local-dist) LOCAL_DIST=1 ;;
  esac
done

if [ "$FROM_GITHUB" -eq 0 ] && [ ! -d "${LOCAL_ROOT}/packages/workit-cursor/.cursor-plugin" ]; then
  FROM_GITHUB=1
fi

if [ "$FROM_GITHUB" -eq 1 ]; then
  mkdir -p "$(dirname "$SHARE")"
  if [ -d "$SHARE/.git" ]; then
    git -C "$SHARE" fetch --tags --force origin
    git -C "$SHARE" checkout main
    git -C "$SHARE" pull --ff-only origin main
  else
    rm -rf "$SHARE"
    git clone --depth 1 "https://github.com/${REPO_SLUG}.git" "$SHARE"
  fi
  ROOT="$SHARE"
else
  ROOT="$LOCAL_ROOT"
fi

# CA-02: self-heal pre-check. The doctor's stale_install check runs against the
# INSTALLED plugin dir (version/selectors vs the current runtime). Exit 2 means
# stale: the refresh below syncs the plugin dir from ROOT and the registration
# pass rewrites the workit MCP/hook entries to the canonical current selector.
# The check reads only workit-owned files, so a healthy install is byte-untouched;
# a registry-unreachable comparison reports registry_unreachable, never stale
# (CA-04) — no false stale_install and no install failure.
if bun "$ROOT/packages/workit-core/scripts/doctor-check.ts" cursor --stale; then
  :
elif [ $? -eq 2 ]; then
  echo "workit: stale Cursor plugin install detected — self-healing (refresh + canonical re-registration)" >&2
else
  echo "FATAL: pre-install doctor probe failed" >&2
  exit 1
fi

chmod +x "$ROOT/packages/workit-core/scripts/sync-runtime.sh" "$ROOT/packages/workit-core/scripts/"*.sh
# Prefer syncing from this ROOT (dev or freshly cloned share)
export WORKFLOW_TOOLKIT_DEV="$ROOT"
"$ROOT/packages/workit-core/scripts/sync-runtime.sh"

# Drop stale CLI skill symlinks (duplicate /wf-* and /wk-* entries)
if [ -d "$SKILLS_DIR" ]; then
  rm -f "$SKILLS_DIR"/wf-* "$SKILLS_DIR"/wk-*
fi

PLUGIN_DIR="$HOME/.cursor/plugins/local/workit"
REGISTRATION_TS="$ROOT/packages/workit-core/src/core/registration.ts"
CURSOR_SETTINGS="$HOME/.cursor/settings.json" CURSOR_MCP="$HOME/.cursor/mcp.json" PLUGIN_DIR="$PLUGIN_DIR" REGISTRATION_TS="$REGISTRATION_TS" LOCAL_DIST="$LOCAL_DIST" bun -e '
import fs from "node:fs";
import path from "node:path";
const {
  mergeCursorSettings,
  mergeCursorMcp,
  mergeCursorHooks,
  cursorMcpServerEntry,
  cursorHooksEntry,
  cursorMcpLocalDistEntry,
  cursorHookLocalDistEntry,
} = await import(process.env.REGISTRATION_TS!);

// RR-06: collapse current + legacy identities; never replace unrelated settings.
const settingsPath = process.env.CURSOR_SETTINGS!;
const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  : {};
const merged = mergeCursorSettings(settings, process.env.PLUGIN_DIR!);
fs.writeFileSync(settingsPath, JSON.stringify(merged.config, null, 2) + "\n");

// RR-06/CA-17: one portable workit MCP registration. Default is the published
// npx pin (Marketplace-safe); --local-dist runs the installed plugin'"'"'s own
// built dist through node so a checkout install carries the current code.
const pluginDir = process.env.PLUGIN_DIR!;
const localDist = process.env.LOCAL_DIST === "1";
const server = localDist
  ? cursorMcpLocalDistEntry(pluginDir)
  : cursorMcpServerEntry(pluginDir);
const mcpPath = process.env.CURSOR_MCP!;
const mcp = fs.existsSync(mcpPath)
  ? JSON.parse(fs.readFileSync(mcpPath, "utf8"))
  : { mcpServers: {} };
const mergedMcp = mergeCursorMcp(mcp, "workit", server);
fs.writeFileSync(mcpPath, JSON.stringify(mergedMcp.config, null, 2) + "\n");

// The plugin'"'"'s own hooks-cursor.json ships the npx pin; the local-dist
// install swaps its sessionStart entry to node against the installed dist.
if (localDist) {
  const hooksPath = path.join(pluginDir, "hooks", "hooks-cursor.json");
  const hooks = fs.existsSync(hooksPath)
    ? JSON.parse(fs.readFileSync(hooksPath, "utf8"))
    : { version: 1, hooks: {} };
  const mergedHooks = mergeCursorHooks(hooks, cursorHookLocalDistEntry(pluginDir));
  fs.writeFileSync(hooksPath, JSON.stringify(mergedHooks.config, null, 2) + "\n");
}
'

# DG-09: verify the just-written Cursor registration with the shared offline doctor.
if ! bun "$ROOT/packages/workit-core/scripts/doctor-check.ts" cursor; then
  echo "FATAL: post-install doctor found an unhealthy Cursor registration" >&2
  exit 1
fi

# CA-08/CA-09: migrate the legacy local plugin identity to `workit` only after
# the canonical registration succeeded; carry the legacy user rules forward first.
LEGACY_PLUGIN_DIR="${HOME}/.cursor/plugins/local/workflow-toolkit"
if [ -d "$LEGACY_PLUGIN_DIR" ] && [ "$LEGACY_PLUGIN_DIR" != "$PLUGIN_DIR" ]; then
  if [ -d "$LEGACY_PLUGIN_DIR/rules" ]; then
    mkdir -p "$PLUGIN_DIR/rules"
    for rule in "$LEGACY_PLUGIN_DIR"/rules/*.mdc; do
      [ -e "$rule" ] || continue
      [ -e "$PLUGIN_DIR/rules/$(basename "$rule")" ] || cp "$rule" "$PLUGIN_DIR/rules/"
    done
  fi
  rm -rf "$LEGACY_PLUGIN_DIR"
fi

echo "Cursor plugin installed + auto-sync enabled (sessionStart)."
echo "Share: $SHARE"
ls "$HOME/.cursor/plugins/local/workit/skills" | grep '^wk-' || true
