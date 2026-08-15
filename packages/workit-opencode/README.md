# @brainervirus/workit-opencode

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

Requirements: OpenCode ≥ 1.15.0, Node ≥ 22 (the published plugin is a self-contained Node bundle).

## What it provides

- **12 `wk-*` commands/skills** (`wk-init`, `wk-status`, `wk-verify`, `wk-commit`, `wk-pr`, `wk-changelog`, `wk-release-notes`, `wk-docs-refresh`, `wk-handoff`, `wk-implement`, `wk-meetings`, `wk-issue-update`).
- **Native plugin tools** (`workflow_*`) — branch setup, PR create/context, docs validate/promote, YouTrack post/log/time, templates, rules, presentation, doctor, and handoff.
- **Per-turn enforcement rails** — contract reminder, doc rendering, self-review gates, config guard, issue rails, and post-hoc detectors.

## Host-native behavior

- **Approvals** — flow gates (`workflow_spec_approve` / `workflow_plan_approve` / `workflow_plan_menu`) record native `question` receipts; the self-review validation runs automatically during the transition. Approvals bind to the document's exact SHA-256 digest: editing an approved spec/plan invalidates the approval and forces a fresh reapproval.
- **Lifecycle** — `workflow_plan_pause` / `workflow_plan_resume` / `workflow_plan_complete` move a plan through `pending`/`active`/`paused`/`completed`, each gated by a one-use native-question receipt; completion requires a complete SDD ledger and passing repository verification.
- **Delegation** — approved plans execute through subagent-driven task delegation (native `task`); while a subagent-driven plan is active, coordinator product edits are intercepted.
- **Commit** — `wk-commit` previews a Conventional Commit and confirms through a native `question`.
- **Handoff** — `wk-handoff` seeds and spawns a native OpenCode continuation session; a destination session presents a four-choice menu (never the originating Handoff option) and carries the handoff-destination marker.
- **Diagnostics** — durable JSONL journal plus native `client.app.log()`; nothing is mirrored to `process.stderr` or the agent conversation.

## Bundle / runtime model

The build bundles the `@opencode-ai/plugin` SDK surface used by the adapter into `dist/plugin.js`, so the published plugin has **no** runtime `@opencode-ai/plugin` dependency (it stays a development/build-only pinned dependency). The plugin loads through its real package entry `dist/plugin.js`; commands, skills, vendor skills, and templates ship package-locally under `assets/`.

## Package scripts

```bash
bun run build       # bundle dist/plugin.js + assets
bun run typecheck   # tsc --noEmit
```

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
