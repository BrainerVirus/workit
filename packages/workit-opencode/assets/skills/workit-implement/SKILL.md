---
name: workit-implement
description: Use when scoped implementation, helper delegation, or checkout writer coordination is required by the current task policy
---

# Implement within authority

Implement only inside the current task scope and writer boundary. Assignment is
not launch authority, and a timeout is not proof that a worker stopped.

## Before method work

If there is no active or paused task, run shared `task.start` then `policy.assess`
before relying on selected policy rules or other product mutations. Assessment
selects requirements; do not wait for a rule that can only exist after assess.

## Method

1. Inspect task state, requirements, decisions, candidate, capabilities, and
   current workers with shared `task`, `policy`, and `worker` operations.
2. If a helper is useful, assign one bounded objective with allowed paths,
   applicable requirements, evidence needed, and a stopping condition. Helpers
   cannot change scope, record binding decisions, close or pause the task, assign
   helpers, or resolve blockers for the lead.
3. Observe the native session and worker state. Acquire checkout writer ownership
   through `writer` before any product-mutating command; release it explicitly.
   Cancellation remains uncertain until process exit or explicit recovery.
4. Reconcile the helper report and evidence through shared operations. If required
   delegation is unavailable, continue inline only when policy allows it and state
   the capability limitation.

Do not edit Workit metadata directly, create nested helper trees, widen paths, or
create a second lifecycle. Read-only investigation and bounded reports do not
grant product-write ownership.

When the host reports writer capability unavailable, do not mutate or delegate
mutation. Continue inline only if policy and lead authority permit it;
otherwise report the capability gap.

## Common mistakes

| Mistake                                        | Correction                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| "The helper timed out, so the writer is free"  | Observe exit or perform explicit recovery.          |
| Letting a helper approve its own exception     | Return the decision to the lead/user.               |
| Running a build while another writer is active | Treat builds and tests that mutate state as writes. |
