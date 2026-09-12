---
name: workit-deslop
description: Use before opening a PR or after implementation to remove AI slop from code and prose
---

# Deslop code and prose

Throughput without quality is slop. Clean it with a minimal diff — deslop
never refactors behavior.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Code: delete dead helpers, redundant validators, stub references, and
   comments that restate the code. Comments die by default; keep one only
   with proof of an unchangeable constraint, encoded structurally if cheap.
2. Prose (PR body, spec, docs): cut filler, keep real symbol names and
   before→after numbers. One doc, one purpose.
3. Keep the diff minimal: deslop removes lines, never moves logic. If a
   cleanup wants behavior change, it becomes its own tasked change.

## Completion

A smaller diff with identical behavior and green checks. Report lines
removed, not lines written.

Record passing check evidence linked to the `pre-pr-cleanup` requirement id
from the current policy (`kind: check`, `result: passed`, summary naming what
was removed). That requirement gates `hosting.pull_request` and close. If the
change genuinely has nothing to clean, ask for an approved limitation
decision instead of recording evidence that did not happen.
