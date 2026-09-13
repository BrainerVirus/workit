# Workit contract

Workit keeps one accountable lead and one shared task state. Inspect current
task state before acting; use only the shared operations for task, policy,
evidence, finding, decision, worker, writer, and state changes. Authority is
bounded by the requested scope, current revision, caller/session provenance, and
observed capabilities. Never claim host enforcement or evidence that the host
cannot provide. Preserve unresolved requirements, gaps, and uncertain workers.

Focused methods are loaded only when the resolved policy requires them. A method
must call the shared operations and must not create a second lifecycle, approval
chain, or task-state representation.
