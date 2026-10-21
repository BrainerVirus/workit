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
marker in the workspace store's `hooks/` (`src/hooks/session-marker.ts`, also
the once-per-kind raw-git nudge throttle); nothing is written outside a Workit
workspace. In-process hosts spend a nudge only on the tool result, never in the
pre-tool call. Claude Code's launcher fast path lets workit delivery verbs through.

`src/hooks/stop.ts` is the one stop policy: ledger and local git facts only
(no forge call), at most one continue per turn, never in a subagent or when
the last message asks the user a question. The CI obligation reads the newest
`pr.status` row (`pr`, `branch`, `head`, `checks`), which `workit pr status`
and every `workit ci wait` poll append when the PR's checks summary changed
(`recordPrStatus` in `forge/report.ts`).

The acting session comes from `src/host-session.ts`: `WORKIT_SESSION_ID`, else
the host's shell variable (`CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`,
`PI_SESSION_ID`). Cursor exposes no conversation id to the agent's shell, so
its session context names the id to prefix; that gap is documented in
[the hosts guide](../guides/hosts.md), not papered over.

`realHostSession` classifies the shell's session: `derived` (the host's own
variable), `declared` (`WORKIT_SESSION_ID` under a `WORKIT_HOST`, Claude
Code) or `none` (CI, a plain terminal, Cursor). Before an independent verdict
is recorded, `sessionClaimRefusal` checks the claimed session (env,
`--session`, or the base of `--as`):

- `none`: accepted; `--session X` and `WORKIT_SESSION_ID=X` are one rule.
- The shell's own session. Under any declared `WORKIT_HOST`, a
  `<lead>:<x>` is accepted only if it was issued.
- `<lead>:<real>` where the host sets the variable.
- `<real>:<agent id>` only if issued.
- An issued id whose record holds a token hash only with that token
  (`--token`/`WORKIT_SESSION_TOKEN`, `unbound_session` otherwise).
- With `flag` (`--session`) on a host, only an issued id: the shell's own or
  derived session is refused as `session_flag`.

`workit git commit` runs the same check on its acting session and refuses an
issued id (`judge_session`). The gate (`ledger.ts` `sessionTrust`) re-checks
recorded rows: `unissued_session`, and `unbound_session` for a token-backed id
whose row lacks `sessionBound: true`.

"Issued" means the SubagentStart handler (`handle.ts`, Claude Code and Codex
judges) recorded the id it gave with `recordIssuedSession`, which also mints
a random token: the handler puts it in that subagent's context only, and its
sha256 goes to `<state>/issued-tokens/<lead hash>/<id hash>`, written
exclusively (`wx`: an id is issued once, a replayed SubagentStart gets no
token). The record file carries `workit-issued-sessions/3`. A lead with any
token hash needs one for every id (sticky: an old hook that rewrites a record
in `issued/` cannot unbind it), and a migrated in-repo record never replaces a
per-user one (`COPYFILE_EXCL`). Each id is one
file under `<state>/issued/<lead hash>/` (the per-user state dir, so it holds
across every repository the lead delegates to), at most 64 per lead, and the
write fails open. Ids that 8.10-8.12 hooks wrote into a repository's
`<store>/hooks/issued/` move there the first time workit reads that store. `childSessionId` builds the `<lead>:<child>` shape.

The OpenCode plugin and the Pi launcher set that shape in a child's or
worker's shell:

- OpenCode: `v2/shell-session.ts` correlates `shell.hook("create.before")`,
  which has no session id, with the shell tool's `execute.before` by command
  text. It runs before OpenCode's tool callback sets `OPENCODE_SESSION_ID`
  (opencode v2.0.28 binary: `env.OPENCODE_SESSION_ID=B.sessionID` after
  `trigger("shell","create.before")`).
- Pi: the worker is spawned with `--session-id <worker session>`, and Pi's bash
  tool exports `PI_SESSION_ID` from it (`@earendil-works/pi-coding-agent`
  `dist/core/tools/bash.js`).

An OpenCode child without a Workit worker may record evidence and findings
under its derived id (`v2/child-identity.ts`). Everything else still needs a
validated worker.

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
| Per-turn task context | N `UserPromptSubmit`, resent on change (core) | N every agent-loop call | N `UserPromptSubmit`, resent on change (core) | L: `beforeSubmitPrompt` cannot add context | N `before_agent_start`, resent on change (core) |
| Skill prompt nudge | N `UserPromptSubmit` | N session context | N `UserPromptSubmit` | L: no per-prompt context hook | N `before_agent_start` |
| Delivery (ship) nudge, skill-load recording | N | N | N (`SKILL.md` reads) | N (`SKILL.md` reads) | N |
| Branch policy / raw git deny + nudge | N `PreToolUse` | P: deny via permission effect; L: the nudge rides the result | N `PreToolUse` | P: deny works; nudge via `agent_message` (unverified); X: `postToolUse` context | P: `tool_call` blocks; L: the nudge rides `tool_result` |
| Before-write gate | N `Edit`/`Write`/`MultiEdit`/`NotebookEdit` and shell writes | N permission `evaluate` | N `PreToolUse` on `apply_patch` (files from the patch) and shell writes | P `preToolUse` (a write with no readable path is gated as code) | N `tool_call` |
| Live-session guard (#274) | N `PreToolUse` (edits and shell); owner pid = the hook's parent process | N permission `evaluate` (edits and shell); owner pid = the server process, which runs every child session | N `PreToolUse` (`apply_patch` and shell); X: a per-command `workdir`, if the payload carries one, is not read | P `preToolUse` + `beforeShellExecution`; L: a subagent's tool events carry no parent conversation, so it is matched by the Cursor process | N `tool_call` (edits and bash); a worker's `WORKIT_SESSION_ID` names its lead |
| Raw commit recording | N `PostToolUse` | N `execute.after` | N `PostToolUse` | P: settled on the next shell command; X: `afterShellExecution`/`postToolUse` | N `tool_result` |
| Verifier/reviewer own session | N `SubagentStart` (`workit:verifier`, `workit:reviewer`) | N: child shell gets `WORKIT_SESSION_ID=<lead>:<child>` (`shell.hook("create.before")`), and a child without a worker records evidence and findings under it; native parent binding; X: `agent.transform` definitions | N `SubagentStart` (`workit-verifier`, `workit-reviewer` agent types); P: shipped read-only (`sandbox_mode`) agents the MCP launcher copies into `$CODEX_HOME/agents/` (L: codex-cli 0.160.1 plugins cannot register agents) | P: role markers; L: `subagentStart` cannot add context | N: supervised worker shell gets `WORKIT_SESSION_ID=<lead>:<worker session>`; L: no host subagents |
| Real session for verdicts (`forged_session` refusal) | P: subagent `<lead>:<agent id>` accepted only when SubagentStart issued it, with the token it handed that subagent (each id issued once; binding sticky per lead); L: the token sits in the subagent transcript on disk; L: anyone who can run the hook bundle can mint a new id and token; L: the lead's own id is the declared `WORKIT_SESSION_ID` (no host-set id in the shell; `CLAUDE_CODE_SESSION_ID` unused), so an inline colon-less id such as `<lead>-v<n>` is still declared; L: the issued-id record is per-user state files a deliberate write can forge | N `OPENCODE_SESSION_ID` (set by the shell tool); children `<lead>:<child>`; `WORKIT_HOST=opencode` without it is refused; L: removing both reads as a plain terminal | P `CODEX_THREAD_ID` for the thread; subagent `<lead>:<agent id>` only when SubagentStart issued it, with its token (L: unverified whether a subagent's shell gets its own thread id; `--as verifier` otherwise); `WORKIT_HOST=codex_*` without it is refused; L: the issued-id record is forgeable by a deliberate write | L: no session id in the agent shell and no `WORKIT_HOST`: declared, not checked | N `PI_SESSION_ID` (bash tool); workers `<lead>:<worker session>`; `WORKIT_HOST=pi` without it is refused |
| Implementer worktree guidance | N `SubagentStart` plus `isolation: worktree`; plain git told up front (L: worktree isolation refuses `workit git …`, cannot be turned off) | X: the `worktree` domain is unused | P `SubagentStart` text and the shipped `workit-implementer` agent; L: no native worktree isolation, the lead makes one | P: implementers denied at `subagentStart` | L: no host subagents |
| Compaction restore | N `SessionStart` source=compact | N `session.hook("compaction")` | N `SessionStart` source=compact | P (L: `preCompact` only shows a user message) | N `session_compact` |
| Session trailer on raw commits | N: prepare-commit-msg hook installed by `workit doctor --fix` (via git) | N: prepare-commit-msg hook (via git) | N: prepare-commit-msg hook (via git) | L: no session id in the agent shell, so the trailer only appears when `WORKIT_SESSION_ID` is set | N: prepare-commit-msg hook (via git) |
| Workspace `trailers: false` (no Workit-Session trailer, ledger authorship) | N: `workit git commit`, the hook helper (asks `workit git trailers`), `SubagentStart` text for isolated implementers | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) |
| Extra trailers in the same commit (`workit git commit --trailer`) | N: the contract names it; isolated implementers use `git commit --trailer` | N: contract (bootstrap) | N: contract (`SessionStart`) | N: contract (`sessionStart`) | N: contract (`before_agent_start`) |
| Stop control | N `Stop` (`decision:block`, `stop_hook_active`); a subagent's stop is never blocked | P `session.idle` event, continued with `session.synthetic({resume: true})` only after `outcome: succeeded` (L: no stop hook or loop guard; resume semantics inferred from @opencode/client 2.0.18) | N `Stop` (`decision:block`, `stop_hook_active`) | N `stop` `followup_message` (`loop_count`, registered with `loop_limit: 1`; last message read from `transcript_path`) | N `agent_end` + `sendMessage({triggerTurn})`, never after `stopReason` `aborted`/`error` (L: no host loop guard; the extension keeps one) |
| `/wk-*` aliases | X: plugin commands are namespaced (`/workit:<name>`) | P `command.transform` (prose, not `prompt.skills`) | L: no plugin slash commands (`$workit-<name>`) | N `commands/wk-*.md` | N `registerCommand` |
| Heartbeat / doctor | P plugin check | P version check | N version, hook-trust (`codex_hooks`) and agents (`codex_agents`) checks | N launcher heartbeat | N `pi_extension`: missing, not loading, older than workit |
| PR issue links (`pr create --issue`, #324) | N: CLI flag (no native PR tool: delivery is the CLI's `pr` verbs under grants) | N: CLI flag; the plugin's tools are the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; `workit_context` and the task families are its only tools |
| Hook older than the CLI (`hook_issued_sessions`) | N: the installed hook bundle is read for `ISSUED_SESSIONS_MARKER` | L: issues no subagent ids (children derive theirs) | N: every hook chunk in the plugin cache is read for the marker | L: `subagentStart` cannot add context, so no ids are issued | L: no host subagents; workers derive theirs |

Live-session guard limits:

- **Windows, every host:** there's no process ancestry, so markers carry no
  owner pid. They last until their 15-minute heartbeat, and a session of the
  same host as the owner is never refused, so on Windows the guard only
  separates different hosts (L).
- **Any marker whose pid or start time is unknown:** same rule. A session of
  the same host family is never refused; the pid only decides liveness.
- **Codex:** a shell command is judged against the session's `cwd` from the
  hook payload. A command that sets only its own `workdir` (no `cd`) is judged
  against the session cwd, not that workdir. The installed codex binary names a
  `workdir` field, but nothing shows `PreToolUse` `tool_input` carries it (X).

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
