#!/usr/bin/env bash
# Register the Pi workit extension and skills from the local checkout or share clone.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
SHARE="${HOME}/.local/share/workit"
DEV="${WORKFLOW_TOOLKIT_DEV:-$ROOT}"
PI_CONFIG="${HOME}/.pi/config.json"

chmod +x "$ROOT/packages/workit-core/scripts/sync-runtime.sh"
WORKFLOW_TOOLKIT_DEV="$ROOT" "$ROOT/packages/workit-core/scripts/sync-runtime.sh"

SOURCE="$DEV"
if [ ! -f "$SOURCE/packages/workit-pi/dist/workit.js" ] && [ -f "$SHARE/packages/workit-pi/dist/workit.js" ]; then
  SOURCE="$SHARE"
fi

mkdir -p "$(dirname "$PI_CONFIG")"
PI_CONFIG="$PI_CONFIG" EXT="$SOURCE/packages/workit-pi/dist/workit.js" SKILLS="$SOURCE/packages/workit-pi/skills" bun -e '
import fs from "node:fs";
const path = process.env.PI_CONFIG!;
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const next = {
  ...current,
  extensions: [process.env.EXT!],
  skills: [process.env.SKILLS!],
};
fs.writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
console.log("Registered Pi extension:", process.env.EXT);
'

echo "Pi package registered in $PI_CONFIG"
echo "Complete an explicit v1 cutover before treating this as a generation switch."
