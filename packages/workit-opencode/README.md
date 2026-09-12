# @brainervirus/workit-opencode

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@brainervirus/workit-opencode.svg)](https://www.npmjs.com/package/@brainervirus/workit-opencode)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

OpenCode plugin for workit — workflow rails for agentic coding (specs, plans, YouTrack, CI-gated commits), with host-native approval, delegation, handoff, and diagnostics.

## Install

```jsonc
// opencode.json / opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brainervirus/workit-opencode"]
}
```

Local dev variant (absolute path to this repo):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/workit/packages/workit-opencode/src/plugin.ts"]
}
```

Requirements: OpenCode 1.18.30, Node ≥ 24 (the published plugin is a self-contained Node bundle).

## What it provides

- **Eight native operation tools** — `workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, and `workit_state`.
- **Fourteen policy-selected method skills** — challenge, behavioral TDD, review, plan, implement, debug, handoff,
  babysit, blast-radius, deslop, diagram, mockup, green-run, and steer.
- **Native lifecycle hooks** — host-observed question receipts, direct-child task workers, compact task bootstrap/restoration, and known-surface writer checks.

## Host-native behavior

- **Receipts** — native `question` answers are purpose-bound, session-bound, fresh, and one-use; unrelated questions fail closed.
- **Delegation** — native `task` workers are direct-child-only; nested or uncertain lineage is denied (`delegation_lineage_denied`).
- **Continuity** — compact task context is injected once on session start and once after compaction; unobservable shell surfaces are labeled `agent_guided`.

## Bundle / runtime model

The build bundles the `@opencode-ai/plugin` SDK surface used by the adapter into `dist/plugin.js`, so the published plugin has **no** runtime `@opencode-ai/plugin` dependency (it stays a development/build-only pinned dependency). The plugin loads through its real package entry `dist/plugin.js`; only the fourteen method skills ship under `assets/`.

## Package scripts

```bash
bun run build       # bundle dist/plugin.js + assets
bun run typecheck   # tsc --noEmit
```

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
