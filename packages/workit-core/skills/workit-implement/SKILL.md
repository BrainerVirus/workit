---
name: workit-implement
description: Use when implementing requested code changes in a repository. Follow its rules and host permissions; use Workit tracking and delegation only when continuity or coordination helps.
---

# Implement within authority

Implement within the user request and native host permissions. A task record and
writer ownership are optional coordination tools. Assignment never expands the
request, and a timeout is not proof that a worker stopped.

## Method

1. Inspect the repository, relevant rules, host capabilities, and current work.
   Inspect task state only when this work is already tracked.
2. If a helper is useful, assign one bounded objective with allowed paths,
   applicable requirements, evidence needed, and a stopping condition. Helpers
   cannot change scope, record binding decisions, close or pause the task, assign
   helpers, or resolve blockers for the lead.
3. Use writer ownership only when another Workit actor may mutate the same
   checkout; release it when coordination ends. Cancellation remains uncertain
   until process exit or explicit recovery.
4. Reconcile helper reports and run the checks appropriate to the requested
   outcome. If delegation is unavailable, continue inline when useful.
5. Before a cross-repo mutation, resolve the actual checkout, branch and remote
   from the request and current context. Ask only if competing plausible targets
   remain unresolved. Branch, commit, direct push, PR-ready, merge and release
   are distinct endpoints; perform only the authorized one under target rules.
   Before saying done, reconcile every named deliverable against that checkout
   and verify the requested result. For a push, observe the destination remote
   ref and confirm it contains the delivered commit; report drift or missing
   items as blockers instead of treating local success as remote delivery.

Do not edit Workit metadata directly, create nested helper trees, widen paths, or
create a second lifecycle. Read-only investigation and bounded reports do not
grant product-write ownership.

Do not request writer ownership for a solo edit. If a concurrent Workit writer
cannot be fenced, stop only the conflicting managed writes; ordinary writes still
follow the native host permission and sandbox.

## Common mistakes

| Mistake                                        | Correction                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| "The helper timed out, so the writer is free"  | Observe exit or perform explicit recovery.          |
| Letting a helper approve its own exception     | Return the decision to the lead/user.               |
| Running a build while another writer is active | Treat builds and tests that mutate state as writes. |
