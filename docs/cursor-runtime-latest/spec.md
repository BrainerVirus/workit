# Spec: Cursor runtime resolution via @latest + --prefer-online

**Branch:** `feature/cursor-runtime-latest`

## Context

The Cursor plugin's executable runtime (the MCP server and session-start hook) is the published npm package `@brainervirus/workit-cursor`, launched by static `mcp.json` / `hooks-cursor.json` / `run-cursor-mcp.sh` entries. Today those entries pin the exact reviewed version `@0.8.5` across roughly six hand-edited locations (`registration.ts` `CURSOR_RUNTIME_PACKAGE`, `mcp.json`, `hooks-cursor.json`, `run-cursor-mcp.sh`, two READMEs, plus test fixtures).

Exact pinning is fragile by construction: `semantic-release` computes the npm version at publish time, so a committed static manifest cannot know it ahead of time. Every release therefore needs a human to remember to bump six literal copies, and the pin drifts — we verified that npm already serves `0.8.6` while the committed pin still reads `0.8.5`. The pin was introduced to fix a real bug (`npx -y --package=...@latest` reused a stale `_npx` npm cache and failed with `workit-cursor-mcp: not found`), but npm's documented `--prefer-online` flag solves that root cause directly by forcing fresh re-resolution, without a hand-maintained pin. The original pin spec (`docs/cursor-npx-runtime-pin/spec.md`) even listed exactly this as future work: "Reconsider a mutable dist-tag only if npm provides cache-refresh semantics that are tested across upgrades adding new bins/files."

## Goals

- Replace the hand-maintained exact Cursor runtime pin with `@latest` everywhere, adding `--prefer-online` to every invocation so the stale-`_npx`-cache root cause stays fixed.
- Make `registration.ts`, committed manifests, `run-cursor-mcp.sh`, doctor validation, tests, and docs all agree on one canonical `@latest` + `--prefer-online` selector shape.
- Update the doctor so it accepts only the exact canonical `@latest` + `--prefer-online` shape and rejects exact pins, bare `@latest` (missing `--prefer-online`), and lookalikes.
- Reverse the "never use a mutable `latest` dist-tag" policy in AGENTS.md/READMEs and replace it with the reviewed `--prefer-online` strategy.

## Non-goals

- No change to how Cursor installs or discovers the plugin (Marketplace/Git metadata stays).
- No change to the local `--local-dist` install mode or the node-form local-dist doctor acceptance.
- No change to MCP tools, hook output, skills, rules, or Marketplace metadata beyond the runtime selector.
- No per-release version automation, lockfile, or release-job machinery (that is Option B, deliberately not chosen).

## Architecture

```mermaid
flowchart LR
  %% Cursor runtime resolution — @latest + --prefer-online
  cursor["Cursor plugin MCP/hook"]
  npx["npx -y --prefer-online --package=...@latest"]
  fresh["Force re-resolution (--prefer-online)"]
  registry["npm registry (newest)"]
  bin["Published Workit bins"]
  mcp["MCP and session-start protocols"]
  doctor["Doctor: exact @latest + --prefer-online shape"]
  cursor --> npx
  npx --> fresh
  fresh --> registry
  registry --> bin
  bin --> mcp
  doctor -->|validates| cursor
```

The npm executables remain the only runtime entry points. Static Cursor configuration and core registration helpers switch the package spec from `@0.8.5` to `@latest` and add `--prefer-online` so `npx` re-resolves against the registry instead of reusing a stale `_npx` environment. The doctor validates the exact canonical shape (positional `-y`, `--prefer-online`, `--package=@brainervirus/workit-cursor@latest`, and the correct executable) and rejects every near-miss.

## Data flow / contracts

| Surface | Contract |
| --- | --- |
| MCP package spec | `--package=@brainervirus/workit-cursor@latest` |
| MCP launcher args | `-y`, `--prefer-online`, `--package=@brainervirus/workit-cursor@latest`, `workit-cursor-mcp`, `${workspaceFolder}` |
| MCP executable | `workit-cursor-mcp` |
| Hook command | `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start` |
| Shell entry | `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp "$@"` |
| Doctor | Accepts the exact `@latest` + `--prefer-online` shape only; rejects exact pins, bare `@latest`, and lookalikes |
| Local install | `--local-dist` mode unchanged; default (npx) mode writes the canonical `@latest` + `--prefer-online` shape |
| Marketplace | `mcp.json` / `hooks-cursor.json` ship `@latest` + `--prefer-online`; metadata is still Git-reviewed by Cursor |

## Error handling

- A stale `_npx` cache no longer causes `workit-cursor-mcp: not found` because `--prefer-online` forces re-resolution of the package.
- If the registry is unreachable, `npx` still fails visibly through Cursor MCP/hook diagnostics (same as today); no automatic cache deletion.
- The doctor must not report a healthy Cursor registration unless the configured runtime selector is exactly the canonical `@latest` + `--prefer-online` shape.
- The installer must not report a healthy registration if the doctor rejects the just-written selector.

## Acceptance criteria

- CA-01: No active Cursor manifest, registration helper, doctor expectation, installer fixture, or user documentation references an exact versioned `@0.8.5`-style selector; every selector is `@brainervirus/workit-cursor@latest` with `--prefer-online`.
- CA-02: MCP configuration uses `npx` with exact positional args `-y`, `--prefer-online`, `--package=@brainervirus/workit-cursor@latest`, `workit-cursor-mcp`, `${workspaceFolder}`.
- CA-03: The session-start hook uses `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`.
- CA-04: Doctor accepts the exact `@latest` + `--prefer-online` shape and rejects: an exact pin (`@0.8.5`), bare `@latest` without `--prefer-online`, `@latest-alpha`, prerelease-like and prefix-shared version lookalikes, and executable lookalikes.
- CA-05: Focused tests fail against the current `@0.8.5` source and pass after the `@latest` + `--prefer-online` change (TDD RED→GREEN).
- CA-06: `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp --help` starts the published executable successfully on the local machine (resolves the newest, e.g. `0.8.6`).
- CA-07: Reinstalling the plugin updates the real local Cursor settings while preserving unrelated MCP servers and settings; the Cursor doctor passes.
- CA-08: `bun run check`, release-candidate verification, Marketplace validation, and workflow document validation pass before release.
- CA-09: README, Cursor package README, AGENTS.md, and CHANGELOG Unreleased state the reviewed `--prefer-online` + `@latest` policy, reversing the previous "never a mutable latest dist-tag" wording, without claiming Marketplace submission.

## Decisions

- D-01: Use `@latest` + `--prefer-online` instead of an exact pin. `--prefer-online` (npm's documented cache-refresh flag) fixes the original stale-`_npx` root cause without a hand-maintained pin; the pin was already stale (`0.8.6` published vs `0.8.5` committed).
- D-02: Keep npm-hosted runtime execution for local and Marketplace parity; do not bundle the runtime into the plugin git repo (matches official Cursor plugins, which run `npx pkg@latest` and do not bundle JS).
- D-03: Keep one canonical selector shape and have the doctor enforce it exactly, so no silent drift back to an exact pin or a missing `--prefer-online`.
- D-04: Reject the Option B (automated pin bump) and Option C (single-source codegen) approaches: they add machinery or still leave a human bump, whereas `--prefer-online` + `@latest` is permanent with zero maintenance.

## Future work

- Add a CI smoke step that periodically runs the canonical `npx ...@latest` invocation against the real registry to catch bin/file regressions across upgrades (the original pin spec's condition for revisiting `@latest`).
- Consider a documented `--pin=<version>` override for reproducibility in controlled environments, without changing the default `@latest` behavior.
