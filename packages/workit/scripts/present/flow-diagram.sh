#!/usr/bin/env bash
set -euo pipefail
SPEC_JSON=$(cat)
export SPEC_JSON
python3 <<'PY'
import json, os

spec = json.loads(os.environ["SPEC_JSON"])
direction = spec.get("direction", "TD")
nodes = spec.get("nodes", [])
edges = spec.get("edges", [])
title = spec.get("title")

lines = ["flowchart " + direction]
if title:
    lines.append("  %% " + title)

for n in nodes:
    nid = n["id"]
    shape = n.get("shape", "box")
    label = n.get("label", nid).replace('"', "'")
    if shape == "diamond":
        lines.append('  %s{"%s"}' % (nid, label))
    elif shape == "start":
        lines.append('  %s(["%s"])' % (nid, label))
    else:
        lines.append('  %s["%s"]' % (nid, label))

for e in edges:
    src, dst = e["from"], e["to"]
    lbl = e.get("label")
    if lbl:
        lines.append("  %s -->|%s| %s" % (src, lbl, dst))
    else:
        lines.append("  %s --> %s" % (src, dst))

print("\n".join(lines))
PY
