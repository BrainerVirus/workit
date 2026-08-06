# Spec: Deterministic flow gates + TS consolidation for workflow-toolkit

**Branch:** `feature/workflow-flow-gates`

## Context

The workflow-toolkit contracts (OpenCode bootstrap, Cursor rules/skills) already *describe* the correct flow:

1. Brainstorm → write spec
2. Spec self-review → user review (iterate with notes) → user approval
3. Write plan
4. Plan self-review → user review → user approval
5. Post-plan choice (Subagent-driven / Inline / Handoff / Review spec / Review plan) via native question
6. Implementation or handoff

In practice (observed in Cursor agent CLI sessions, e.g. thread `6d4560aa` "Toolkit Issues Report"), agents skip the gates: they write spec + plan in one shot, skip the spec self-review, skip the user-review gates, never offer handoff, and keep working in the same chat. The current gates are prose in skills — prose does not stop models (grok-4.5, etc.) from skipping them.

Additionally, the toolkit carries duplicated logic: `src/legacy/*.js` (used by the OpenCode plugin) and `cursor/mcp/lib/*.js` (used by the Cursor MCP server) are two copies of the same wrappers, both shelling out to `scripts/lib/*.sh` / `scripts/sdd/*.sh` / `docs-validate.py`. Two implementations of the same logic = two places for bugs, double maintenance.

## Goals

1. Make the flow sequence **deterministic**: tools hard-fail when a step is attempted before its prerequisite is approved. No "agent remembers to close the spec first".
2. Give the user an explicit, tool-recorded approval gate (`self_reviewed` → `approved`) that requires a native question confirmation.
3. Make the post-plan choice menu mandatory and tool-recorded: implementation/handoff refuse to run without evidence the menu was presented.
4. Consolidate all logic into one TS + zod core shared by both platforms; delete the legacy JS wrappers, bash/python script layer, and duplicated copies.

## Non-goals

- Startup performance of opencode (cancelled — user keeps MCPs, DB, plugins, autoupdate as-is).
- Vendoring superpowers into the toolkit (separate spec, later).
- Changing the review *policy* (max 2 rounds, Critical/Important block, Minor advisory roll-up) — already decided in the deterministic-gates release.
- Migrating to Go/Rust for tools (rejected — YAGNI; TS+zod is the single shared implementation).

## Architecture

### 1. Flow state file (shared, deterministic)

Location: `docs/superpowers/sdd/<slug>/flow.json` (alongside the existing SDD ledger).

Shape:

```json
{
  "slug": "<plan-basename>",
  "spec": { "path": "docs/superpowers/specs/...-design.md", "status": "draft" },
  "plan": { "path": "docs/superpowers/plans/....md", "status": "draft" },
  "menu": { "presented": false, "chosen": "" },
  "updated_at": 1785960000000
}
```

Status transitions (enforced by tools):

- `draft` → `self_reviewed`: `workflow_spec_approve` with `confirmed: true` (agent declares self-review done).
- `self_reviewed` → `approved`: second `workflow_spec_approve` with `confirmed: true` — the skill instructs the agent to call this **only after** the user gave explicit approval via a native question. (Same for plan.)
- No backward transitions. `workflow_plan_approve` hard-fails unless `spec.status === "approved"`.

A file-based store is used (not the in-memory `WorkflowStateStore`) so both platforms (OpenCode plugin + Cursor MCP server) share the same state, and handoff to a new session preserves it.

### 2. New tools (registered in both platforms, same signatures)

- `workflow_flow_status` (read-only): `{ spec_path?, plan_path? }` → current status of both docs, or `draft` if no flow.json exists.
- `workflow_spec_approve`: `{ confirmed: true, spec_path }` → transition per the rules above; records `updated_at`.
- `workflow_plan_approve`: `{ confirmed: true, plan_path }` → same for plan; hard-fails unless spec `approved`.
- `workflow_plan_menu`: `{ confirmed: true, plan_path, choice: "subagent-driven"|"inline"|"handoff"|"review-spec"|"review-plan" }` → records `menu.presented = true` + `chosen`. Called by the agent after the native question menu is answered.

All new tools validate args with zod (via `tool.schema`) and use the existing `confirmed: true` pattern already present in `workflow_sdd_task_brief` / `workflow_sdd_review_package`.

### 3. Hard-fail gates in existing flows

- `wf-implement` (execution-contract path): refuses to run unless `plan.status === "approved"` AND `menu.presented === true` (choice may be any of the five). Error message states exactly which gate is missing.
- `wf-handoff`: refuses to run unless `spec.status === "approved"` and `plan.status === "approved"`. Handoff carries the flow.json path in the seeded continuation prompt so the new session can consult it.
- `workflow_docs_validate` (existing): unchanged behavior; called after spec write and after plan write as today.

### 4. Skill updates (prose that calls the tools)

- `brainstorming` skill (as shipped in the toolkit's skills): after writing the spec, agent must call `workflow_spec_approve` (`self_reviewed`), then run self-review, then ask the user via native question, then `workflow_spec_approve` (`approved`) only after user approval. Same cycle for the plan via `workflow_plan_approve`.
- After plan approval: native question menu (5 options), then `workflow_plan_menu` records the choice, then either `wf-implement` (which checks the gates) or `wf-handoff`.
- These skill instructions live in the toolkit's own skills/wf-implement + templates (the toolkit already overrides Superpowers behavior — vendoring later will move the source of truth, not the mechanism).

### 5. TS/zod consolidation (delete legacy)

Current:

```
src/tools/*.ts        → src/legacy/*.js (wrapper)       → scripts/lib/*.sh + docs-validate.py
cursor/mcp/server.js  → cursor/mcp/lib/*.js (copy)      → same scripts
```

Target:

```
src/core/*.ts             ← ALL logic in pure TS, zod-validated args
  ├── docs-validate.ts    (port of docs-validate.sh/.py)
  ├── branch.ts           (port of resolve-docs-branch.sh)
  ├── plan-tasks.ts       (port of parse-plan-tasks.sh)
  ├── sdd.ts              (port of scripts/sdd/*.sh)
  ├── flow-state.ts       (NEW — gates above)
  ├── git.ts              (port of git-context.js)
  ├── handoff.ts          (port of resolve-handoff-branch.sh + collect-handoff-context.sh)
  ├── youtrack.ts         (port of youtrack.js)
  └── present.ts / repo.ts / changelog.ts / verify.ts / init.ts
src/plugin.ts             ← thin: registers tools in-process (no subprocess)
cursor/mcp/server.js      ← thin: imports the SAME src/core
```

Deleted:

- `src/legacy/` (16 files)
- `cursor/mcp/lib/` (duplicate copy)
- `scripts/lib/*.sh`, `scripts/lib/docs-validate.py`, `scripts/sdd/*.sh` (logic ported to TS)
- The `runScript`/`runScriptJson` subprocess indirection (plugin calls are in-process)

Kept:

- `scripts/*.sh` at top level that are install/sync/context helpers (install-*-plugin.sh, sync-runtime.sh, run-cursor-mcp.sh, pr-create.sh, verify-project.sh, context collectors) — these are operational scripts, not duplicated logic. Port them to TS only if they turn out to be core logic during implementation; otherwise leave as-is (mark any kept-but-delegated calls with a `ponytail:` comment).

### 6. Tests

Single suite against `src/core` (replacing the current split `bun test` + `npm --prefix cursor/mcp test` duplication):

- `docs-validate` port: same fixtures as today (valid pair passes, broken link/branch/task-order fails).
- `flow-state` (NEW): transition matrix — draft→self_reviewed→approved; plan approve before spec approve fails; backward transitions fail; menu unrecorded blocks implement.
- `branch` port: keep-on-feature, create-from-develop, main→develop flow.
- Verification: `bun run check` (existing) still green, plus `tsc --noEmit` over the new core.

## Data flow

1. User asks for a feature → brainstorm → spec written → `workflow_spec_approve(confirmed)` → status `self_reviewed`.
2. Agent self-reviews spec (advisory loop; Critical/Important block, Minor accumulate) → native question to user → user approves → `workflow_spec_approve(confirmed)` → `approved`.
3. Plan written → `workflow_plan_approve(confirmed)` → `self_reviewed` → self-review → native question → `workflow_plan_approve(confirmed)` → `approved`.
4. Native question menu (5 options) → `workflow_plan_menu(confirmed, choice)` → `menu.presented = true`.
5. `wf-implement` (checks gates) or `wf-handoff` (checks gates, seeds continuation with flow.json path).

## Error handling

- Any tool call with `confirmed !== true` returns the existing "confirmed: true required" failure.
- Gate violations return explicit, actionable errors: which doc, current status, which tool to call next.
- Missing flow.json = everything `draft` = most gates fail closed (safe default).
- Flow.json write conflicts: last-write-wins with `updated_at` stamp; acceptable for a single-user tool (ponytail: no locking; add if concurrent sessions on same slug become a real problem).

## Compatibility

- Existing sessions that never created a flow.json: treated as `draft`; `wf-implement`/`wf-handoff` will hard-fail until the user approves via the new flow. This is intentional (hard-fail is the product decision from the deterministic-gates release).
- The `workflow_sdd_*` tools, YouTrack tools, and present tools keep their current names/signatures (only their internals move into `src/core`).

## Out of scope (tracked separately)

- Vendoring superpowers (own spec).
- Cursor-side skill packaging (the toolkit's `cursor/skills` already mirrors the opencode skills; updating the skill text there is part of implementation, but the mechanism stays).
