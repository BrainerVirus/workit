# Diagrams: only when one argues a decision

Tables first, ASCII trees second, Mermaid only when a flow or architecture
needs it. Flowchart, sequence, state or ER only. No renderer, no network.

## Mermaid rules (v11)

- Fence as ```` ```mermaid ```` with no prose inside the fence.
- Quote labels containing punctuation: `A["input (x, y)"]`.
- One direction per diagram (`TD` or `LR`); under twelve nodes.
- Name actors exactly as the code names them.

## Verify by reading

Balanced quotes and brackets, every node reachable, labels match the spec's
terms. If it cannot be verified by reading, delete it. One diagram that argues
a decision, or none; never a diagram suite.
