---
name: workit-bdd
description: Use when turning a requirement, issue or acceptance criterion into tests, or when tests should read as behavior (Given/When/Then, BDD, scenarios, acceptance tests, test names and seams)
---

# Behavior first: Given/When/Then

Write each acceptance criterion as Given/When/Then before any code, then let
it name the test and pick the seam. A test reads like the spec it proves.

## Method

1. Write the scenarios. One behavior per scenario, in the user's or caller's
   words: `Given <state>, When <action>, Then <observable result>`. Include the
   unhappy paths a caller depends on (denied, empty, invalid, timeout).
2. Agree the seams. Pick the highest stable interface the scenario can be
   observed through: a CLI verb, a public function, an HTTP route. Ideally one
   seam per feature. Write the seams down; do not test at an unagreed seam.
3. Name the tests after the scenarios. The test name is the Given/When/Then
   sentence; the body is arrange (Given), act (When), assert (Then).
4. Use Gherkin only where the repo already does (`.feature` files with
   playwright-bdd, cucumber, jest-cucumber). Otherwise plain test names carry
   the scenario; do not add a BDD framework.
5. Build in vertical tracer bullets: one scenario RED, the smallest change to
   GREEN, then the next scenario. Never write all tests first.
6. Mock only at system boundaries: network, clock, randomness, other
   processes, sometimes the filesystem. Never mock the unit or its internal
   collaborators; use the real thing or an in-memory adapter behind a port.
7. Expected values come from the scenario, never from the code: a literal from
   a worked example, the spec or an external contract.

## Completion

Every acceptance criterion maps to a named test at an agreed seam, each one
was seen RED before GREEN, and the audit finds no tautologies:

```sh
workit test-audit --diff --fail-on high
```
