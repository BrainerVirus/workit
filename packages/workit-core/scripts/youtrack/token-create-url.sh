#!/usr/bin/env bash
# Ported to TS — CLI contract kept: execs bun <core>/ports/youtrack-token-create-url.ts
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$SCRIPT_DIR/../../src/core/ports/youtrack-token-create-url.ts" "$@"
