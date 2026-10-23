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
| Issued-registry guard (#292): agent writes under `<state>/issued*` | N `PreToolUse` on edit tools and shell writes (also under `workit check -- bash -c`) | N permission `evaluate` (edits and shell) | N `PreToolUse` on `apply_patch` and shell; L: `write_stdin` and specialized shell paths are not interceptable | P `preToolUse` + `beforeShellExecution`; a write with no readable path is not matched | N `tool_call` (edits and bash) | 
| Heavy-command gate (#325, ruling mvid5onk) | N `PreToolUse` after every Workit gate: one simple heavy command gets `updatedInput` `workit check --heavy -- <cmd>` (the CLI caps the lease wait at 100 s in a Claude Code shell) with no `permissionDecision` (claude 2.1.306 applies it, then its own permission flow); a chain with heavy parts is denied with the split; a command a deny/ask rule names, or one only a `workit` allow would cover (not under `bypassPermissions`), runs as typed with a note. Rules read: managed-settings.json, `$CLAUDE_CONFIG_DIR`/`~/.claude/settings.json`, project `.claude/settings.json` and `settings.local.json`. L: `--settings`, `--allowedTools`/`--disallowedTools`, SDK `canUseTool` and server-managed policy are unreadable | N `execute.before` runs the permission hook's gates on the original, then rewrites one simple heavy command to `workit check --heavy -- <cmd>` (before the shell-session correlation notes it); `permission.evaluate` denies an allowed chain with heavy parts (ask and deny stand). Rules read: global, project and `.opencode/` `opencode.json(c)` up to the git top, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`: `permission.bash`/`shell` and every `agent.*.permission` | X: `PreToolUse` supports `updatedInput` rewrites (learn.chatgpt.com/docs/hooks), unused here; it denies one heavy command with the exact `workit check --heavy -- <cmd>` and a chain with the split. Rules read: `~/.codex/rules/*.rules` and project `.codex/rules/*.rules` (`prefix_rule`); a rule it cannot parse means pass through | L: `beforeShellExecution` answers only allow/deny/ask: denies with the exact rewrite or the split. Rules read: `~/.cursor/cli-config.json` and project `.cursor/cli.json` `Shell(x)`. L: the IDE allowlist/denylist is unreadable | N `tool_call` after the gates: mutates `event.input.command` for one simple heavy command, blocks a chain with the split (Pi has no permission rules to read) |
| Hook deadline under load (#309); each host's deadline sits below its own timeout (`HOST_DEADLINES`; `WORKIT_HOOK_DEADLINE_MS` overrides all) | N: `hooks.json` timeouts 15 s (prompt, tool, subagent) and 20 s (`SessionStart`, `Stop`); deadline 8 s, 16 s for `SessionStart` and `Stop`; past it the hook answers `additionalContext` naming the skip | L: in-process plugin, no host timeout to beat (the server awaits the hook); no deadline applied | N: `Stop` `timeout: 20`, deadline 16 s; unset hooks keep Codex's default timeout (600 s per the Codex hooks docs, not read from the binary), deadline 45 s | N: no `timeout` set, so Cursor's 60 s default holds (`DEFAULT_HOOK_TIMEOUT_SECONDS`, cursor-agent 2026.09.26); deadline 45 s on every event, `subagentStart` included (`agent_message` on `beforeShellExecution`) | L: in-process extension, no host timeout; no deadline applied |
| `cd <dir> && workit …` normalised to `workit --cwd <dir> …` (#388, `hooks/cwd-normalize.ts`) | N `PreToolUse` `updatedInput`, no `permissionDecision`, so `Bash(workit:*)` matches; only `cd <literal dir> && workit … [2>&1] [\| tail\|head\|grep …]`, anything else (`cd $VAR`, `cd -`, `;`, `\|\|`, another segment) runs as typed; a heavy-gate rewrite wins (a workit command is never heavy itself) | N: the shell hook already strips the `cd` | X: `PreToolUse` supports `updatedInput` (learn.chatgpt.com/docs/hooks), unused here: nothing is denied or rewritten, the contract text (`workit <verb> --cwd <dir>`) carries it | L: `beforeShellExecution` cannot rewrite: contract text only | N: no permission layer, nothing to normalise |
| Session id without an env prefix | N: none needed | N: shell env set by the host | N: `CODEX_THREAD_ID` | N: Cursor puts no session id in the shell, so the addendum says `workit --session <id> …` (global flag, only before the command; `WORKIT_SESSION_ID` still works and the flag wins; on a host that checks the session the flag meets `sessionClaimRefusal` like the env var). | N: `PI_SESSION_ID` |
| Raw commit recording | N `PostToolUse` | N `execute.after` | N `PostToolUse` | P: settled on the next shell command; X: `afterShellExecution`/`postToolUse` | N `tool_result` |
| Branch-scoped worker assignment gate (#316) | L: no launch gate; a subagent is not tied to a worker assignment | N `execute.before` binds a native launch to the current branch's task; one unlaunched worker left on another task is rebound to it (assigned there, cancelled with a reason naming both tasks); anything ambiguous is denied with a branch-scoped hint | L: no launch gate | L: no launch gate | L: workers are supervised by workit, no native launch gate |
| Verifier/reviewer own session | N `SubagentStart` (`workit:verifier`, `workit:reviewer`) | N: child shell gets `WORKIT_SESSION_ID=<lead>:<child>` (`shell.hook("create.before")`), and a child without a worker records evidence and findings under it; native parent binding; X: `agent.transform` definitions | N `SubagentStart` (`workit-verifier`, `workit-reviewer` agent types); P: shipped read-only (`sandbox_mode`) agents the MCP launcher copies into `$CODEX_HOME/agents/` (L: codex-cli 0.160.1 plugins cannot register agents) | P: role markers; L: `subagentStart` cannot add context | N: supervised worker shell gets `WORKIT_SESSION_ID=<lead>:<worker session>`; L: no host subagents |
| Real session for verdicts (`forged_session` refusal) | P: subagent `<lead>:<agent id>` accepted only when SubagentStart issued it, with the token it handed that subagent (each id issued once; binding sticky per lead); L: the token sits in the subagent transcript on disk; L: anyone who can run the hook bundle can mint a new id and token; L: the lead's own id is the declared `WORKIT_SESSION_ID` (no host-set id in the shell; `CLAUDE_CODE_SESSION_ID` unused), so an inline colon-less id such as `<lead>-v<n>` is still declared; L: the issued-id record is per-user state files a deliberate write can forge | N `OPENCODE_SESSION_ID` (set by the shell tool); children `<lead>:<child>`; `WORKIT_HOST=opencode` without it is refused; L: removing both reads as a plain terminal | P `CODEX_THREAD_ID` for the thread; subagent `<lead>:<agent id>` only when SubagentStart issued it, with its token (L: unverified whether a subagent's shell gets its own thread id; `--as verifier` otherwise); `WORKIT_HOST=codex_*` without it is refused; L: the issued-id record is forgeable by a deliberate write | L: no session id in the agent shell and no `WORKIT_HOST`: declared, not checked | N `PI_SESSION_ID` (bash tool); workers `<lead>:<worker session>`; `WORKIT_HOST=pi` without it is refused |
| Exact verdict line at judge start (#271 S2a, `verdictCommand`) | N `SubagentStart` for `workit:verifier`/`workit:reviewer`: `workit ledger verdict <verified\|failed\|blocked> --kind <live\|unit> --branch <b> --session <lead>:<agent id> --token=<t> --how "…"` (`--kind review` for a reviewer); an id SubagentStart already issued gets no command, only "spawn a fresh verifier"; `--branch` is the checkout's branch, or `<branch>` on a protected branch or detached HEAD (ruling mvij5l86); implementers get none | N `<workit-verdict-line>` in the child's `session.hook("context")` system parts, for any child but an implementer worker (no Workit agent types name a judge, ruling mvij5le6); no `--session`/`--token`: the child shell already acts as `<lead>:<child>` | N `SubagentStart` for `workit-verifier`/`workit-reviewer`, same line as Claude Code | L: `subagentStart` cannot add context, and judges are marked in the task text, not by agent type (ruling mvij5lpm) | L: supervised workers have no shell tool (`--tools` allowlist without `bash`), so they cannot run `workit ledger verdict`; reviewers record evidence and findings (ruling mvij5ljz) |
| Bounded task brief for children (`task inspect`, #342) | N: CLI `task inspect` prints the brief (no native task tool; subagents call the CLI) | N: a child with no worker may call `workit_task` `inspect` (`v2/child-identity.ts`) and gets the brief; its other task actions stay denied | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: a worker's `workit_task` `inspect` returns the brief; L: Pi has no host subagents beyond workers |
| Decider call (#335: one fix round and one recheck, then a decider; `ledger decision --by decider`) | N: skills plus the host-neutral CLI; second decider on another model via `model` on the Agent call | P: skills plus the CLI; second decider is a child session on another configured agent | P: skills plus the CLI; L: one decider, the host picks no per-spawn model | N: skills plus the CLI; second decider on another model via the optional `model` argument of the Task tool (cursor-agent 2026.09.26 bundle) | P: skills plus the CLI; L: one decider, the host picks no per-spawn model |
| Standing-order deltas and the stop line to running workers (#320, `hooks/standing.ts`; the automatic stop on memory/CPU pressure waits for #326) | N `PreToolUse` `additionalContext`, once per revision; the subagent is `agent_id` under the lead's `session_id`, its baseline taken at `SubagentStart`; X: only the matchers workit registers (Bash, PowerShell, edits, Skill), so a worker that only reads sees it on its next one; the launcher fast path loads the runtime only when `standing/rev` differs from the agent's seen file | N `<workit-standing>` in the child's `session.hook("context")` system parts on every model call while the change stands (the system context is rebuilt per call, so it never stacks); the child is its `parentID`, its baseline its first call | P `PreToolUse` `additionalContext` (matcher `*`), baseline at `SubagentStart`; L: unverified that a subagent's `PreToolUse` carries the lead's `session_id` with its `agent_id`; a thread on a slice branch is matched by branch | P `agent_message` on `beforeShellExecution` (unverified that the model reads it) and `additional_context` on `preToolUse`; L: a subagent's tool events carry no parent conversation, so only a session on a slice branch is a worker (implementer subagents are denied anyway) | P: the worker's next `tool_result` (L: `tool_call` cannot add context); a supervised worker acts as `<lead>:<worker session>` and is seeded at launch |
| Implementer worktree guidance (#310) | N `SubagentStart`: the lead's `workit fanout worktree create` worktree, `workit --cwd <worktree> git\|check …` one verb per call; the agent has no `isolation` (Claude Code's refused every unverifiable command and every wrapped git, and cannot be turned off). An implementer still spawned with `isolation: "worktree"` (cwd `.claude/worktrees/agent-<id>`) gets the plain-git text instead | X: the `worktree` domain is unused | P `SubagentStart` text and the shipped `workit-implementer` agent; L: no native worktree isolation, the lead makes one | P: implementers denied at `subagentStart` | L: no host subagents |
| Implementer worktree confinement (#310, `hooks/worktree-confine.ts`) | N `PreToolUse` (edits, shell writes, mutating raw git, `workit --cwd <dir> git commit\|branch`) for `agent_type` `workit:implementer`: the first change inside a worktree whose admin dir holds the fanout token binds the agent (`<git common dir>/workit/worktree-bind/`, a `worktree.bound` row); after that a change outside it is denied naming it, before that one outside every Workit worktree. Files outside any repository are host policy; an agent in `.claude/worktrees/agent-<its id>` is left to the host. L: writes the shell analysis cannot see (interpreters, a `workit check -- <cmd>` script behind `--cwd`) are not judged; read-only git is never denied | L: the permission `evaluate` hook gets the child session but no agent type, so a child is never bound to a worktree (a worker assignment could carry one: follow-up) | P `PreToolUse` for `agent_type` `workit-implementer`, same rules; L: unverified that a subagent's `PreToolUse` carries `agent_id` and `agent_type` (`agentIdOnTool: partial`) | L: implementers are denied at `subagentStart`, so none runs to confine | L: no host subagents; supervised workers carry no agent type |
| Worktree dependencies (#310, `worktree-deps.ts`) | N: `workit fanout worktree create` mirrors the main checkout's git-ignored `node_modules` (and `*/node_modules`, `*/*/node_modules`) one level deep: relative links (workspace packages, `.bin`) resolve inside the worktree, installed packages link to the main checkout's; skipped with a note when git does not ignore `node_modules`. Measured on this repository: 866 entries in 18 ms, against 342 ms for a warm-cache `bun install --frozen-lockfile` | N: same CLI | N: same CLI | N: same CLI | N: same CLI |
| Compaction restore | N `SessionStart` source=compact | N `session.hook("compaction")` | N `SessionStart` source=compact | P (L: `preCompact` only shows a user message) | N `session_compact` |
| Session trailer on raw commits | N: prepare-commit-msg hook installed by `workit doctor --fix` (via git) | N: prepare-commit-msg hook (via git) | N: prepare-commit-msg hook (via git) | L: no session id in the agent shell, so the trailer only appears when `WORKIT_SESSION_ID` is set | N: prepare-commit-msg hook (via git) |
| Workspace `trailers: false` (no Workit-Session trailer, ledger authorship) | N: `workit git commit`, the hook helper (asks `workit git trailers`), `SubagentStart` text for isolated implementers | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) |
| Extra trailers in the same commit (`workit git commit --trailer`) | N: the contract names it; isolated implementers use `git commit --trailer` | N: contract (bootstrap) | N: contract (`SessionStart`) | N: contract (`sessionStart`) | N: contract (`before_agent_start`) |
| Stop control | N `Stop` (`decision:block`, `stop_hook_active`); a subagent's stop is never blocked | P `session.idle` event, continued with `session.synthetic({resume: true})` only after `outcome: succeeded` (L: no stop hook or loop guard; resume semantics inferred from @opencode/client 2.0.18) | N `Stop` (`decision:block`, `stop_hook_active`) | N `stop` `followup_message` (`loop_count`, registered with `loop_limit: 1`; last message read from `transcript_path`) | N `agent_end` + `sendMessage({triggerTurn})`, never after `stopReason` `aborted`/`error` (L: no host loop guard; the extension keeps one). L on every host (#394): no non-blocking notice channel at a stop, so at endpoint `pr` a PR with no verdict yet stops silently; the verdict ask waits for `green`/`merged` |
| `/wk-*` aliases | X: plugin commands are namespaced (`/workit:<name>`) | P `command.transform` (prose, not `prompt.skills`) | L: no plugin slash commands (`$workit-<name>`) | N `commands/wk-*.md` | N `registerCommand` |
| Heartbeat / doctor | P plugin check | P version check | N version, hook-trust (`codex_hooks`) and agents (`codex_agents`) checks | N launcher heartbeat | N `pi_extension`: missing, not loading, older than workit |
| PR issue links (`pr create --issue`, #324) | N: CLI flag (no native PR tool: delivery is the CLI's `pr` verbs under grants) | N: CLI flag; the plugin's tools are the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; `workit_context` and the task families are its only tools |
| Continuing a reported worker (#313) | L: no continuation gate; a subagent turn is resumed natively, so the lead follows `fanout brief --mode resume` by convention | N: `subagent` with a `sessionID` is refused (`delegation_lineage_denied`) unless the worker is running or its worktree has uncommitted changes; the refusal prints `workit fanout brief <slice> --mode resume` | L: no continuation gate | L: no continuation gate | L: no host subagents |
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

Hook deadline limits:

- **The handler is not preempted.** The deadline is checked before the
  handler runs and raced against what is async (reading stdin). The handler
  itself is synchronous, so once it starts it runs to the end. If it ends
  past the deadline, its full answer is still sent and recorded as `late`.
  Preempting it would need a worker thread and new bundle entries (X).
- **Skips are fail-open.** A skipped pre-tool hook applies no branch policy,
  no write gate and no heavy-command rewrite to that one command. A skipped
  `Stop` never continues the turn. Skips and late answers go to
  `<state dir>/hook-skips.jsonl`, and `workit doctor` (`hook_deadline`)
  counts the last day's.

Issued-registry guard limits (#292):

- It judges agent tool calls only; the CLI and the `SubagentStart` hook write
  the registries unhindered. It reads edit paths and recognizable shell writes
  (redirects, `tee`, `cp`, `mv`, `rm`, `sed -i`, `touch`, through `cd`, `~`,
  `$HOME` and `workit check -- bash -c`). An interpreter (`python -c`), an
  unexpanded other variable or a command substitution is not seen (L, every
  host), so this is a guard against hand edits, not a sandbox (#329 moves the
  state into the DB).
- The Claude Code launcher's fast path and the Codex launcher's quiet path
  send any edit or shell command whose text names `issued` or the state dir to
  the runtime, so a checkout with no task store is guarded too. Windows paths
  match across `\` and `/`, case, drive form and 8.3 short names.
- **Codex:** `write_stdin` and specialized tool paths carry no readable
  target, so they are not gated (L).
- **Cursor:** a write whose payload names no path is not matched (P).

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
