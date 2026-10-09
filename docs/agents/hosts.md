# Core, hosts and adapters

Read before touching a host adapter (`packages/workit-<host>/`), hooks,
setup or upgrade, grants, agent-facing tool schemas, or YouTrack code. The
rules for that code (core vs adapters, never fabricate, lenient readers,
hooks fail open, migrations, grants) are in
[CODING_STANDARDS.md](../../CODING_STANDARDS.md).

## Checks that enforce the rest

These rules are guarded by tests; the failure names what to fix.

- Agent-facing tool schemas stay flat (depth 1): add fields in
  `packages/workit-core/src/core/operation-input.ts`, not nested objects.
  Guard: `test/workit-mcp/server.test.ts`.
- The Cursor MCP launcher shape (`npx -y --prefer-online
  --min-release-age=0 --package=@brainervirus/workit-cursor@latest …`, see
  npm/cli#9765) and the hook launcher (`node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" <bin>`,
  pinned, `failClosed: false`, never `@latest`) are defined in
  `packages/workit-cli/src/admin/registration.ts` and checked by the doctor,
  `test/artifacts/manifests.test.ts`, `test/artifacts/registration.test.ts`
  and `test/workit-cursor/hook-launcher.test.ts`.
- YouTrack hosts, issue ids and timezones come from `youtrack.json`;
  `test/workit-core/youtrack-work-date.test.ts` scans shipped source for them.

## Raw git/forge steering and session ids

`packages/workit-core/src/hooks/raw-git.ts` classifies shell commands by text
(no git spawn except reading a new commit) and is shared by every host: Claude
Code, Codex and Cursor through `handleHook`, OpenCode through
`v2/permissions.ts` and `v2/shell.ts`, Pi through `src/tools.ts`. It denies
gate bypasses only inside a Workit workspace, nudges routine raw commands, and
records raw commits for the session (post-tool event; Cursor, which has none
registered, settles a pending marker on the next shell command). Keep the
classification string-only: hook latency is guarded by the bundle size test
and the Codex entry-size test in `test/workit-core/hooks/bundle.test.ts`.

`src/hooks/skill-nudge.ts` (same hosts, same fail-open rule) adds the skill
nudges: a prompt phrase table (`PROMPT_INTENTS`, phrases only, by precedence;
the contract's single-word triggers stay for the model), the workit-ship line
on delivery commands, and `skill.loaded` rows. Per-session nudge state is a
marker in the workspace store's `hooks/`; nothing is written outside a Workit
workspace. Claude Code's launcher fast path lets workit delivery verbs through.

The acting session comes from `src/host-session.ts`: `WORKIT_SESSION_ID`, else
the host's shell variable (`CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`,
`PI_SESSION_ID`). Cursor exposes no conversation id to the agent's shell, so
its session context names the id to prefix; that gap is documented in
[the hosts guide](../guides/hosts.md), not papered over.

## Host parity

Every workit feature ships for all five hosts (Claude Code, OpenCode, Codex,
Cursor, Pi) through each host's native mechanism, or records a host limit in
this table. Check host capabilities against the installed host package or its
docs, never against workit's own descriptors.

A descriptor's `events` say what workit **registers** on that host. An event
marked `native` or `partial` must be registered in the host's hooks config
(Claude Code, Codex, Cursor) or plugin source (OpenCode, Pi), and a hook-process
host registers nothing its descriptor does not map. Guard:
`test/workit-core/hooks/descriptor-drift.test.ts`. A hook the host offers but
workit does not register yet is marked `none` there and listed below as
missing.

N = native, P = partial, X = missing (the host has a mechanism workit does not
use yet), L = host limit (the host has no mechanism for it).

| Feature | Claude Code | OpenCode | Codex | Cursor | Pi |
| --- | --- | --- | --- | --- | --- |
| Session-start contract | N `SessionStart` | N per-call `session.hook("context")` (no start event) | N `SessionStart` | N `sessionStart` (fire-and-forget: may race the first turn) | N `session_start` / `before_agent_start` |
| Per-turn task context | N `UserPromptSubmit`, resent on change (plugin cache) | N every agent-loop call | N `UserPromptSubmit`, resent on change (core) | L: `beforeSubmitPrompt` cannot add context | P: once per session and after compaction; X: on-change resend through `before_agent_start` |
| Skill prompt nudge | N `UserPromptSubmit` | N session context | N `UserPromptSubmit` | L: no per-prompt context hook | N `before_agent_start` |
| Delivery (ship) nudge, skill-load recording | N | N | N (`SKILL.md` reads) | N (`SKILL.md` reads) | N |
| Branch policy / raw git deny + nudge | N `PreToolUse` | P: deny via permission effect; L: the nudge rides the result | N `PreToolUse` | P: deny works; nudge via `agent_message` (unverified); X: `postToolUse` context | P: `tool_call` blocks; L: the nudge rides `tool_result` |
| Before-write gate | N `Edit`/`Write`/`MultiEdit`/`NotebookEdit` and shell writes | N permission `evaluate` | N `PreToolUse` on `apply_patch` (files from the patch) and shell writes | P `preToolUse` (a write with no readable path is gated as code) | N `tool_call` |
| Raw commit recording | N `PostToolUse` | N `execute.after` | N `PostToolUse` | P: settled on the next shell command; X: `afterShellExecution`/`postToolUse` | N `tool_result` |
| Verifier/reviewer own session | N `SubagentStart` (`workit:verifier`, `workit:reviewer`) | P: native parent binding; X: `agent.transform` definitions | N `SubagentStart` (`workit-verifier`, `workit-reviewer` agent types); P: shipped read-only (`sandbox_mode`) agents the MCP launcher copies into `$CODEX_HOME/agents/` (L: codex-cli 0.160.1 plugins cannot register agents) | P: role markers; L: `subagentStart` cannot add context | L: no host subagents (supervised workers) |
| Implementer worktree guidance | N `SubagentStart` plus `isolation: worktree` | X: the `worktree` domain is unused | P `SubagentStart` text and the shipped `workit-implementer` agent; L: no native worktree isolation, the lead makes one | P: implementers denied at `subagentStart` | L: no host subagents |
| Compaction restore | N `SessionStart` source=compact | N `session.hook("compaction")` | N `SessionStart` source=compact | P (L: `preCompact` only shows a user message) | N `session_compact` |
| Stop control | X `Stop`/`SubagentStop` | X `session.idle` | X `Stop` | X `stop` followup | X `agent_end` |
| `/wk-*` aliases | X: plugin commands are namespaced (`/workit:<name>`) | P `command.transform` (prose, not `prompt.skills`) | L: no plugin slash commands (`$workit-<name>`) | N `commands/wk-*.md` | N `registerCommand` |
| Heartbeat / doctor | P plugin check | P version check | N version, hook-trust (`codex_hooks`) and agents (`codex_agents`) checks | N launcher heartbeat | N `pi_extension`: missing, not loading, older than workit |

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
