# @brainervirus/workit-opencode

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@brainervirus/workit-opencode.svg)](https://www.npmjs.com/package/@brainervirus/workit-opencode)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

OpenCode plugin for Workit — optional coordination, policy, delegation, handoff, and read-only context. Native OpenCode tools execute Git, hosting, YouTrack and documentation effects.

## Install

```jsonc
// opencode.json / opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brainervirus/workit-opencode"]
}
```

OpenCode V2 uses `"plugins"`; V1 uses `"plugin"`.

Local dev variant (absolute path to this repo; use `plugins` on V2):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/workit/packages/workit-opencode"]
}
```

Requirements: OpenCode 1.18.30+ (V1) or 2.0.18+ (V2), Node ≥ 24. The published
plugin is a self-contained Node bundle; its default export is a dual entry
(`server()` for V1, `setup()` for V2), so the same pin works on both hosts.

## What it provides

- **Eight native operation tools** — `workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, and `workit_state`.
- **Read-only context and init tools** — `workit_context` accepts `{ "kind": "git" }` and the existing PR/YouTrack/changelog/release/affected context fields; `workit_init_apply` keeps confirmed configuration initialization.
- **Fourteen policy-selected method skills** — challenge, behavioral TDD, review, plan, implement, debug, handoff,
  babysit, blast-radius, deslop, diagram, mockup, green-run, and steer.
- **Native lifecycle hooks** — host-observed question receipts, direct-child task workers, compact task bootstrap/restoration, and known-surface writer checks.

## Host-native behavior

- **Receipts** — native `question` answers are purpose-bound, session-bound, fresh, and one-use; unrelated questions fail closed.
- **Delegation** — native `task` workers are direct-child-only; nested or uncertain lineage is denied (`delegation_lineage_denied`).
- **Continuity** — compact task context carries the newest decisions and bounded redacted choice summaries, injected once on session start and once after compaction; unobservable shell surfaces are labeled `agent_guided`.

Workit does not register `workit_external_action` on either OpenCode version.
Use native tools for mutations under the host permissions and target conventions;
no Workit task, writer or decision is needed merely to run an ordinary command.
Old action/decision history is preserved. Inspect and reconcile any uncertain
effect before retrying; removal does not settle or migrate it.

## Upgrade from Workit 1.x

Workit 2.0 removes the managed external-action tool on both OpenCode versions.
Use native host tools for mutations and `workit_context` for read-only context.
Existing task and action history remains untouched; reconcile uncertain effects
before retrying them.

## Bundle / runtime model

The build bundles the `@opencode-ai/plugin` (V1) and `@opencode/plugin` (V2) SDK surfaces used by the adapters into `dist/plugin.js`, so the published plugin has **no** runtime dependency on either SDK (both stay development/build-only pins). The plugin loads through its real package entry `dist/plugin.js`; only the fourteen method skills ship under `assets/`.

The V2 entry registers the same ten tools with `codemode: false`, the fourteen
skills and up to fourteen `wk-*` commands. Existing user skills and commands
are preserved; an alias is added only when its Workit skill is registered. It
also provides question receipts for `decision.record`, direct-child subagent
lineage with durable dispatch claims, and bootstrap/task/worker context plus
compaction injection. Its shell
permission hook adds branch-name policy denials for direct, unquoted literal
branch-creation forms only. It leaves compliant branches, PR and worktree
commands, and unsupported shell syntax to OpenCode's native permission rules.

## Package scripts

```bash
bun run build       # bundle dist/plugin.js + assets
bun run typecheck   # tsc --noEmit
```

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
