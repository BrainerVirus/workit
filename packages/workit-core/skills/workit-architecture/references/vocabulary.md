# Deepening vocabulary

Use these words exactly in every candidate. Do not drift into "component",
"service", "API" or "boundary".

| Term | Meaning |
| --- | --- |
| Module | Anything with an interface and an implementation: a function, a file, a package, a slice across tiers |
| Interface | Everything a caller must know: types, invariants, ordering, error modes, configuration, cost |
| Depth | Behavior a caller or test reaches per unit of interface learned. Deep: much behind little. Shallow: the interface is nearly as complex as the implementation |
| Seam | Where behavior can change without editing that place; where an interface lives |
| Adapter | A concrete thing that fills a seam (production, in-memory, fake) |
| Leverage | What callers gain from depth: one implementation pays back across many call sites and tests |
| Locality | What maintainers gain: change, bugs and verification concentrate in one place |

## Tests to run on a suspect

- **Deletion test.** Imagine deleting the module. Complexity vanishes: it was
  a pass-through, so inline it. Complexity reappears across callers: it earns
  its keep. A deepening concentrates complexity; it does not just move it.
- **Interface is the test surface.** Tests that must reach past the interface
  mean the module has the wrong shape.
- **One adapter is a hypothetical seam; two are a real one.** Do not add a
  port unless something varies across it (production and test count).

## What the explorer looks for

- One concept that needs a hop through many small modules to understand.
- Shallow modules: wide interface, thin implementation.
- Pure helpers extracted only for tests while the bugs live in how they are
  called (no locality).
- Coupled modules leaking through their seams: one fix edits both (churn shows
  them changing together).
- Code that is untested, or hard to test through its current interface.

The explorer returns only cited findings (file, commit, ledger row), never a
refactor.

## Dependency categories (how the deeper module is tested)

1. In-process (pure, in-memory): merge and test through the new interface.
2. Local stand-in exists (temp dir, in-memory store): test with the stand-in;
   the seam stays internal.
3. Owned but remote (your own service): a port at the seam, an in-memory
   adapter in tests.
4. Third party: an injected port, a fake adapter in tests.

Replace, do not layer: once tests at the deeper interface exist, the old tests
on the shallow modules are waste; the slice deletes them.
