# Spec: Windows pr-create test timeout

**Branch:** `bugfix/windows-pr-create-test-timeout`

## Context

CI run `31954943055` on `main` (commit `ae2fab4b`) failed on the `workit-core` Windows job: `pr-create.sh create: target branch flows from config for every preset (RL-03)` timed out after bun's default 5000ms per-test budget (13.5s wall). The same commit passed on a sibling run, so the failure is a flaky cold-start timeout, not a logic error.

The test spawns 4 preset cases × (git init/config/commit, bare remote init, `git push -u origin develop`, then `prCreate` which now also pushes the branch before `gh/glab create` per the routing repair). The file already has an established precedent: the `pr-create.sh: missing gh/glab on PATH` test carries `{ timeout: 60_000 }` with the comment "Windows git cold starts exceed the default 5s per-test budget" (workspaces-scripts.test.ts:345-348). The RL-03 test (line 688) was extended by PR #45 with more git spawns and a real push but did not inherit that timeout.

## Goals

- Give `pr-create.sh create: target branch flows from config for every preset (RL-03)` the same 60s per-test budget the sibling heavy-git test already uses.
- Make the Windows workit-core CI job deterministic for this test across re-runs.

## Non-goals

- No change to test logic, assertions, or the push-before-create behavior itself.
- No change to any production code.
- No rename, Marketplace, or other backlog work.

## Architecture

No architecture or data-flow change; this is a per-test timeout option.

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| Per-test timeout | bun test's third argument `{ timeout }`; the file precedent uses `60_000` for multi-git-spawn tests on Windows cold starts. |

## Acceptance criteria

- CA-01: The RL-03 target-flow test passes with `{ timeout: 60_000 }` on Windows, matching the sibling test's budget.
- CA-02: The test's assertions and behavior are unchanged; only the timeout option is added.
- CA-03: CI on this branch (workit-core Windows job) is green.

## Decisions

- D-01: Reuse the file's existing 60s precedent instead of inventing a new budget or restructuring the test — the sibling test documents the same Windows cold-start cause.

## Future work

- If Windows git cold starts keep breaching 60s under heavier future tests, raise the budget or set a file-level default.
