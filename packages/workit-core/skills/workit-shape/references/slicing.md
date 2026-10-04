# Slicing into PRs

A slice is a tracer bullet: a narrow but complete path through every layer it
needs (schema, logic, interface, tests), demoable or verifiable on its own, and
small enough for one fresh context window and one reviewable PR.

## Rules

1. Prefer five narrow PRs to one large one. Each PR tells one part of the story.
2. Prefactor first: "make the change easy, then make the easy change". A
   behavior-preserving refactor is its own slice, below the feature.
3. Order by dependency, then by risk: the slice that can prove the idea wrong
   goes first.
4. Every slice lists its acceptance as Given/When/Then lines and the command
   that verifies it. No acceptance, no slice.
5. Mark the edges: independent slices branch from the trunk and can fan out
   (workit-fanout); a slice that needs another's code stacks on it.
6. Wide mechanical changes use expand-contract: add the new path, migrate
   callers in batches, then delete the old path.

## Stacking

```sh
workit stack plan feature/a feature/b feature/c   # bottom ... top, no mutation
workit pr create --base feature/a --fill          # on feature/b: each PR targets its parent
workit stack sync                                 # restack, lease-push, retarget
workit stack status
```
The bottom PR targets the trunk; each child targets its parent branch. Fixes
land in the lowest PR that owns the code.

## Plan entry (one per slice)

```md
### S2 feature/usage-endpoint  (stacks on S1)
Touches: usage route, usage query
Acceptance:
- Given a workspace with 3 runs, When GET /v1/usage, Then it returns {"runs":3}
- Given no auth header, When GET /v1/usage, Then it returns 401
Verify: workit check test; verify-<app> "usage" feature
Decisions: counts are per UTC day (ledger 01J...)
```
