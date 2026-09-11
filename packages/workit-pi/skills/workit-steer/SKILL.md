---
name: workit-steer
description: Use when new instructions, interruptions, or forgotten items arrive mid-task
---

# Steer without losing the thread

New context mid-session is normal; losing the thread is not. Park,
classify, handle, re-anchor — every time.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Park current state to task progress verbatim: summary, nextAction,
   blockers. Never trust memory across an interruption.
2. Classify the steering:
   - same-task: fold into scope (reassess if facts changed), continue.
   - new-task: `task.start` + `policy.assess`; the parked task waits.
   - quick-question: answer from the parked state, then resume.
3. Handle it with the same rigor as the parked work (no drive-by edits).
4. Re-anchor: one-line resume brief (where we were, what changed, what
   is next) before touching the parked work again.

## Completion

Both the steering and the parked work have an owner, a next action, and
no silent drops. Interrupted work resumes from the brief, not from recall.
