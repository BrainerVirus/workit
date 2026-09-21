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

Requirements: OpenCode 1.18.30+ (V1) or 2.0.3 (V2), Node ≥ 24. The published
plugin is a self-contained Node bundle; its default export is a dual entry
(`server()` for V1, `setup()` for V2), so the same pin works on both hosts.

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

The build bundles the `@opencode-ai/plugin` (V1) and `@opencode/plugin` (V2) SDK surfaces used by the adapters into `dist/plugin.js`, so the published plugin has **no** runtime dependency on either SDK (both stay development/build-only pins). The plugin loads through its real package entry `dist/plugin.js`; only the fourteen method skills ship under `assets/`.

The V2 entry registers the same ten tools with `codemode: false`, the fourteen
skills and `wk-*` commands (user collisions preserved), question receipts for
`decision.record`, direct-child subagent lineage with durable dispatch claims,
shell route and worktree denial through `permission.evaluate`, and the
bootstrap/task/worker context plus compaction injection.

## Package scripts

```bash
bun run build       # bundle dist/plugin.js + assets
bun run typecheck   # tsc --noEmit
```

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
