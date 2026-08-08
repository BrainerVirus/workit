#!/usr/bin/env bash
# Ported to TS — CLI contract kept: execs bun <core>/ports/init-apply.ts
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$SCRIPT_DIR/../../src/core/ports/init-apply.ts" "$@"
