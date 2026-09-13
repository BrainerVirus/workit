---
name: workit-diagram
description: Use when a spec or plan needs a flow or architecture diagram
---

# Mermaid when needed, never by default

Tables first, ASCII trees second, mermaid only when a flow or architecture
needs it. Flowchart, sequence, state, or ER only. No renderer, no network.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Syntax rules (mermaid v11)

- Fence as ` ```mermaid `, no surrounding prose inside the fence.
- Quote node labels containing punctuation: `A["input (x, y)"]`.
- One direction per diagram (`TD` or `LR`); keep nodes under twelve.
- Name actors exactly as the codebase names them (real symbols only).

## Verify

Re-read the fence before commit: balanced quotes/brackets, every node
reachable, labels match spec terms. If it cannot be verified by reading,
delete it.

## Completion

One diagram that argues a decision, or nothing. Never a diagram suite.
