---
name: workit-mockup
description: Use when a UI decision needs sketching before implementation
---

# ASCII mockups before UI code

Sketch, don't build. Three genuinely different layout hypotheses maximum,
ASCII only, no code output.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Fix a legend (`┌─┐ │ └─┘ ░ ≈ [ ] ( )`) and keep sketches 60-80 cols,
   8-20 rows.
2. Per hypothesis: regions, component reuse vs new (named against the
   existing codebase), empty/loading/populated/error states, nav flow.
3. Ask at most one clarifying question, then recommend. Flag hi-fi
   escalation when ASCII cannot settle it (density, motion, brand).

## Completion

The sketch plus the decision lands in the spec dir. Throwaway by design.
