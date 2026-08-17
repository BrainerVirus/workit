# Spec: Cursor subagent-driven execution + true inline

**Branch:** `feature/cursor-subagent-inline`

## Context

The Cursor host adapter deliberately disables subagent-driven plan execution: `cursorMutationContext` (packages/workit-cursor/mcp/flow-evidence.ts) hard-codes `role: "coordinator"` and `taskIdentity: undefined`, and `recordPlanMenuChoice` (flow-state.ts:1610) rejects `subagent-driven` with `unsupported_mode` whenever the host is Cursor. The stated reason is a security boundary: the Cursor MCP receives only tool arguments and has no host parentID the way OpenCode does (OpenCode derives a delegated role from session `parentID` via `roleFromParentage`), so a client-supplied role/taskIdentity would let the main model self-certify as a delegated worker and re-open the coordinator boundary.

This is confusing UX and leaves a real capability unused. Cursor does have native subagents (the user is using them today), so a subagent-driven plan is achievable — but only with a delegated identity the MCP can trust. Separately, when the user picks **Inline** on Cursor, execution currently falls into the coordinator+subagent pattern (the `wk-implement` skill), so "inline" is not actually single-agent like OpenCode's `executing-plans` path. Both defects are host-adapter issues, not core-logic issues.

## Goals

- Enable **subagent-driven** plan execution on Cursor using Cursor's native subagents, backed by a coordinator-issued, task-bound, single-use token that the Cursor MCP validates against flow state before granting a delegated worker identity — closing the self-certification hole.
- Make **Inline** on Cursor truly single-agent: route it to the `executing-plans` skill (one agent executing tasks directly), not the `wk-implement` coordinator+subagent pattern.
- Keep **Handoff** as-is: Cursor already builds a pasteable prompt for a hand-made next session (`workit_handoff_prompt`); no change needed beyond the rename in the sibling spec.
- Keep the coordinator boundary intact: coordinator product edits remain blocked while a subagent-driven plan is active, and delegated workers must present a valid token for the active task in the current workspace.

## Non-goals

- No change to the OpenCode host's delegation model (session parentage stays).
- No change to the CLI host's execution model.
- No change to evidence/receipt semantics for approvals and the post-plan menu.
- No unification of Cursor and OpenCode delegation mechanisms; Cursor uses tokens, OpenCode uses host parentage, per the "use what each host has" principle.
- No change to the existing Cursor handoff prompt behavior.

## Architecture

```mermaid
flowchart TD
  %% Cursor subagent-driven + inline
  menu["Post-plan menu (Cursor)"]
  sub["Subagent-driven (Cursor-native subagents)"]
  inl["Inline (single agent)"]
  hand["Handoff (pasteable prompt)"]
  coord["Coordinator (main agent)"]
  tok["Task-bound token"]
  mcp["Cursor MCP mutation tools"]
  verify["Token verified vs flow state"]
  grant["Grant delegated worker identity"]
  exec["executing-plans skill"]
  menu -->|Subagent-driven| sub
  menu -->|Inline| inl
  menu -->|Handoff (prompt)| hand
  coord -->|creates task token| tok
  tok -->|passes in prompt| sub
  sub -->|mutation + token| mcp
  mcp -->|validate token vs flow state| verify
  verify -->|delegated identity| grant
  inl -->|executing-plans (single agent)| exec
```

When the coordinator chooses Subagent-driven, it calls a new `workit_delegate` tool to mint a token bound to a specific task id and the current workspace, then passes the token in each subagent's prompt. The subagent includes the token when it calls mutation tools (`workit_sdd_task_brief`, `workit_sdd_append_progress`, `workit_sdd_review_package`, and the other allowlisted tools). The Cursor MCP validates the token against the flow state — it must reference the active task in the current workspace and be unconsumed — before granting `role: "delegated"` with that task as `taskIdentity`. Inline routes to `executing-plans` (single agent).

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| Task-bound token | A single-use, flow-state-verified value the coordinator mints for one task in one workspace; grants delegated-worker identity when presented with a mutation. |
| Delegated identity | The `MutationContext.role === "delegated"` + `taskIdentity` combination a validated token produces on Cursor. |
| Coordinator | The main Cursor session that runs the post-plan menu and dispatches subagents; product edits remain blocked while a subagent-driven plan is active. |
| Inline | Single-agent execution via `executing-plans`; the current session does all tasks directly. |

| Contract rule | Required behavior |
| --- | --- |
| Token minting | A `workit_delegate` tool (or equivalent) creates a token bound to `(slug, taskId, workspaceRoot)`; it is stored in the SDD/flow state and is single-use. |
| Token validation | The Cursor MCP validates a presented token against the active task in the current workspace; it must be valid and unconsumed, else the mutation is rejected (`invalid_token` / `consumed_token`). |
| Delegated grant | A validated token yields `role: "delegated"` with `taskIdentity` = the bound task; the `delegated_unauthenticated` guard passes. |
| Coordinator block | While a subagent-driven plan is active, coordinator product mutations stay blocked (existing guard). |
| Inline routing | Choosing Inline routes to the `executing-plans` skill (single agent), not `wk-implement`'s coordinator pattern. |
| Host parity | OpenCode keeps session-parentage delegation; Cursor uses tokens; the shared core accepts both as long as `MutationContext` is host-derived and trustworthy. |

## Error handling

- A missing, invalid, expired, or already-consumed token rejects the mutation with a structured error explaining the requirement (the coordinator must mint a fresh token for the subagent).
- A token presented for the wrong task or workspace is rejected.
- If the registry/flow state is unavailable, the mutation fails closed (no delegated grant).
- Inline never delegates: it executes in-session and does not mint tokens.

## Acceptance criteria

- CA-01: Choosing Subagent-driven on Cursor no longer returns `unsupported_mode`; the flow state records `mode: "subagent-driven"` with Cursor evidence.
- CA-02: The coordinator can mint a task-bound token for a task in the current workspace via a `workit_delegate` (or equivalent) tool; the token is single-use and bound to `(slug, taskId, workspaceRoot)`.
- CA-03: A Cursor subagent presenting a valid, unconsumed token for the active task in the current workspace receives `role: "delegated"` with `taskIdentity` set; the `delegated_unauthenticated` guard passes and the mutation proceeds.
- CA-04: A missing/invalid/consumed/wrong-task/wrong-workspace token is rejected with a structured error, and the mutation fails closed.
- CA-05: Coordinator product mutations remain blocked while a subagent-driven plan is active (existing guard unchanged).
- CA-06: Choosing Inline on Cursor routes to single-agent `executing-plans` execution; the current session does tasks directly without orchestrator+subagent delegation.
- CA-07: OpenCode and CLI hosts are unchanged: OpenCode keeps session-parentage delegation, CLI keeps its command flow; a parity test proves the shared core accepts both delegation sources.
- CA-08: The Cursor post-plan menu (rule text + `ask-question-only.mdc`) reflects that Subagent-driven is now supported, Inline is single-agent, and Handoff is the pasteable prompt.
- CA-09: Full repository verification passes: lint, format:check, tests, build, changelog (`bun run check` / `workflow_verify`).

## Decisions

- D-01: Use a coordinator-issued, task-bound, single-use token for Cursor delegation because the Cursor MCP has no host parentID; the token is flow-state-verified (not client-chosen) so it preserves the coordinator boundary.
- D-02: Keep OpenCode's session-parentage model unchanged; Cursor uses tokens — "use what each host has" rather than forcing one mechanism.
- D-03: Route Cursor Inline to `executing-plans` (single agent) so it matches OpenCode's inline behavior; `wk-implement` remains the subagent-driven coordinator path.
- D-04: Keep Cursor Handoff as the pasteable prompt (already implemented); no change.

## Future work

- Consider a time-to-live on tokens to bound validity windows.
- Consider whether the token mechanism can be reused for cross-host delegated identity if a host later gains verified parentage.
