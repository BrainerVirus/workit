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
  "plugins": ["@brainervirus/workit-opencode"]
}
```

OpenCode 2.x reads `"plugins"` and still normalizes the older `"plugin"` key.

Local dev variant (absolute path to this repo):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///path/to/workit/packages/workit-opencode"]
}
```

Requirements: OpenCode 2.0.18+, Node ≥ 24. The published plugin is a
self-contained Node bundle whose default export is the V2 plugin definition
(`{ id: "workit", setup }`). Workit 3.0 removed the OpenCode 1.x `server()`
adapter; OpenCode 1.x hosts must stay on Workit 2.x by pinning
`"plugin": ["@brainervirus/workit-opencode@2"]` (the V1 key) until they upgrade
OpenCode.

## What it provides

- **Seven native operation tools** — `workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, and `workit_state`.
- **Read-only context and init tools** — `workit_context` accepts `{ "kind": "git" }` and the existing PR/YouTrack/changelog/release/affected context fields; `workit_init_apply` keeps confirmed configuration initialization.
- **Eleven policy-selected method skills** — shape, implement, review, debug, ship, continue, bdd, test-audit,
  deslop, fanout, and verify-app.
- **Native lifecycle hooks** — direct-child task workers and compact task bootstrap/restoration. Workit registers no question hooks.

## Host-native behavior

- **Delegation** — native `task` workers are direct-child-only; nested or uncertain lineage is denied (`delegation_lineage_denied`).
- **Continuity** — compact task context carries the newest decisions and bounded redacted choice summaries, injected once on session start and once after compaction; unobservable shell surfaces are labeled `agent_guided`.

Workit does not register `workit_external_action` on OpenCode.
Use native tools for mutations under the host permissions and target conventions;
no Workit task or decision is needed merely to run an ordinary command. Decisions
are durable records that satisfy decision requirements; they never authorize an
effect. Delivery limits come from OpenCode permissions plus the workspace
autonomy grants (`workit grant show`).
Old action/decision history is preserved. Inspect and reconcile any uncertain
effect before retrying; removal does not settle or migrate it.

## Upgrade from Workit 1.x

Workit 2.0 removes the managed external-action tool on both OpenCode versions.
Use native host tools for mutations and `workit_context` for read-only context.
Existing task and action history remains untouched; reconcile uncertain effects
before retrying them.

## Bundle / runtime model

The build bundles the `@opencode/plugin` SDK surface used by the adapter into `dist/plugin.js`, so the published plugin has **no** runtime dependency on the SDK (it stays a development/build-only pin). The plugin loads through its real package entry `dist/plugin.js`; only the eleven method skills ship under `assets/`.

The plugin registers nine tools (the seven families, `workit_context` and
`workit_init_apply`) with `codemode: false`, the eleven
skills and up to eleven `wk-*` commands. Existing user skills and commands
are preserved; an alias is added only when its Workit skill is registered. It
also provides direct-child subagent
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
