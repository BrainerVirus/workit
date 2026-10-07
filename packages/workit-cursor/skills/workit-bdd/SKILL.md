---
name: workit-bdd
description: Turn requirements into Given/When/Then scenarios, agree the test seam, and work test-first in vertical RED/GREEN slices. Use for BDD, TDD, acceptance criteria, scenarios, Given/When/Then, write a test first.
---

# Behavior first: Given/When/Then

1. **Write the scenarios.** One behavior each, in the caller's words:
   `Given <state>, When <action>, Then <observable result>`. Include the
   unhappy paths callers depend on (denied, empty, invalid, timeout).
2. **Agree the seam.** The highest stable interface the scenario can be
   observed through: a CLI verb, a public function, an HTTP route; ideally one
   per feature. Do not test at a seam nobody agreed to.
3. **Name tests after scenarios.** The name is the Given/When/Then sentence;
   the body is arrange, act, assert. Expected values come from the scenario (a
   literal from a worked example, the spec, an external contract), never from
   the code under test. No tautological tests: a test must fail if the
   behavior breaks, never restate the implementation.
4. **Build in vertical slices.** Write one vertical RED slice that fails for
   the missing behavior and run it through the CLI so the failure is observed:
   `workit check test`. Make the smallest change, run the same check GREEN,
   then take the next scenario. Any edit makes the observation stale; re-run
   before you claim it. A recorded "tests pass" is a note, and an ad-hoc
   `workit check -- <cmd>` never satisfies the gate: only the configured
   `test` check does. No `test` detected? Create `workit.checks.json`, copying
   in every check the repo already runs: once it exists it replaces the
   detected defaults.
5. **Mock only at system boundaries:** network, clock, randomness, other
   processes, sometimes the filesystem. Never the unit or its own
   collaborators; use the real thing or an in-memory adapter behind a port.
6. **Gherkin only where the repo already uses it** (`.feature` files with
   playwright-bdd, cucumber, jest-cucumber). Otherwise test names carry it.

Reject noise: version-pin assertions, tests that mirror private structure,
assertions inside a possibly-empty loop, smoke-only renders, duplicates. If a
test still passes when every imported function returns `undefined`, rewrite it;
the audit finds these (read the `workit-test-audit` skill's SKILL.md and follow it).

## Example

Bad: `test("calculateTotal works", () => expect(calculateTotal(items)).toBe(items.reduce((s, i) => s + i.price, 0)))`

Good: `test("Given two items of 5 and 10, When totalled, Then the total is 15", () => expect(calculateTotal([{ price: 5 }, { price: 10 }])).toBe(15))`

## Check

```sh
workit test-audit --diff && workit check test
```
