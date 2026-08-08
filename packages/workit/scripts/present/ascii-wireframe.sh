#!/usr/bin/env bash
set -euo pipefail
export SPEC_JSON
SPEC_JSON=$(cat)
export SPEC_JSON
python3 <<'PY'
import json, os, sys

spec = json.loads(os.environ["SPEC_JSON"])
title = spec.get("title", "UI")
width = int(spec.get("width", 72))
rows = spec.get("rows", [])

def box_line(text, w):
    inner = w - 4
    if len(text) > inner:
        text = text[: inner - 1] + "…"
    return "│ " + text.ljust(inner) + " │"

top = "┌" + "─" * (width - 2) + "┐"
bot = "└" + "─" * (width - 2) + "┘"
lines = [top, box_line(title, width)]
lines.append("├" + "─" * (width - 2) + "┤")

for row in rows:
    kind = row.get("type", "text")
    if kind == "separator":
        lines.append("├" + "─" * (width - 2) + "┤")
        continue
    if kind == "header":
        lines.append(box_line(row.get("label", ""), width))
        continue
    if kind == "button":
        label = "[ " + row.get("label", "Button") + " ]"
        lines.append(box_line(label.center(width - 4), width))
        continue
    if kind == "field":
        label = row.get("label", "Field")
        value = row.get("value", "_______________")
        lines.append(box_line(f"{label}: {value}", width))
        continue
    if kind == "columns":
        cols = row.get("columns", [])
        col_w = (width - 4 - len(cols) + 1) // max(len(cols), 1)
        parts = []
        for c in cols:
            t = c.get("label", "")[: col_w - 1]
            parts.append(t.ljust(col_w))
        lines.append(box_line(" | ".join(parts).strip(), width))
        continue
    lines.append(box_line(row.get("label", str(row)), width))

lines.append(bot)
print("\n".join(lines))
PY
