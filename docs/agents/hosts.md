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
  --min-release-age=0 --package=@workit-dev/cursor@latest …`, see
  npm/cli#9765) and the hook launcher (`node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" <bin>`,
  pinned, `failClosed: false`, never `@latest`) are defined in
  `packages/workit-cli/src/admin/registration.ts` and checked by the doctor,
  `test/artifacts/manifests.test.ts`, `test/artifacts/registration.test.ts`
  and `test/workit-cursor/hook-launcher.test.ts`.
- YouTrack hosts, issue ids and timezones come from `youtrack.json`;
  `test/workit-core/youtrack-work-date.test.ts` scans shipped source for them.

## YouTrack client

Agents reach YouTrack only through `workit youtrack …`, never raw API calls.
That is a CLI verb, so every host gets it through its shell tool with no
adapter code. Workit never reads, writes, prompts for or stores a YouTrack
token: ytrack keeps it in the OS keyring. All YouTrack I/O goes through one
seam, `YouTrackBackend` in `packages/workit-core/src/core/youtrack-backend.ts`
(`showIssue`, `createIssue`, `addComment`, `addWorkItem`, and `texts` for the
marker read-back), and its only implementation, `ytrackBackend`, runs
`ytrack … --json` (`core/youtrack-ytrack.ts`). It sets `YTRACK_HOST` from
`youtrack.json`'s `baseUrl` and passes no token.

- ytrack missing: `unavailable`, unblock `install ytrack (…youtrack-cli:
  install.sh, or install.ps1 on Windows), then ytrack auth login --host <host>`
  (`ytrackMissingUnblock`).
- Exit 4 (not logged in): `unavailable`, unblock `ytrack auth login --host
  <host>` (`ytrackLogin`; the flag is `--host`). Exit 2 and 4 on a write, and
  a missing ytrack, are `not_applied`; exit 1 is `unknown` (read back).

`youtrack-tools.ts` `defaultOperations` (PR backlinks, MCP tools) and
`fetchYouTrackIssueBody` (context reads) route through the same backend.
`ytrackStatus()` and `ytrackReadiness()` give the doctor, `workit setup` and
the OpenCode init action ytrack's version and per-host login. Setup and init
write `youtrack.json` without a token; a leftover `youtrack.token` is only
checked for existence (doctor warns it can be deleted, setup leaves it
untouched); `test/workit-core/youtrack-no-token.test.ts` scans shipped source
so no token read comes back. Writes need `WORKIT_YT_WRITE=1`
(`youTrackWriteGate`). `findYtrack` ignores `PATH` when `WORKIT_NO_YTRACK=1`,
which the test preload sets, so a test never spawns a developer's real ytrack:
tests use a stub `ytrack` on a `PATH` in an env they build.

The ytrack agent skill (youtrack-cli #16) ships inside ytrack, stamped with
its version: `ytrack skill print` and `ytrack skill install --dir <root>
--json` (`{path, version}`; it refuses a `<root>/ytrack` that is not its
skill). Workit never copies its text. `core/ytrack-skill.ts` probes support
with `ytrack skill print` (exit 0; ytrack 0.2.1 and older have no `skill`), installs into
each host's root (`hostSkillsRoot` in the CLI's `upgrade/shared.ts`, sources in the parity table below) and
records the directories it created in `<state dir>/ytrack-skill.json`. A
ytrack skill that was there first is refreshed but not recorded, so
`workit uninstall` leaves it. Uninstall removes a recorded row only when its
path is exactly that host's `<root>/ytrack` and no component from the home
down is a symlink (`ytrackSkillPathRefusal`, checked when planning and again
before deleting); any other recorded path is reported and left untouched. `workit setup` and `workit upgrade` call it
through `upgrade/ytrack-skill.ts` (`refreshYtrackSkill`) for each selected host
with Workit installed, only when `youtrack.json` exists or a workspace tracks
issues in YouTrack.

## Raw git/forge steering and session ids

`packages/workit-core/src/hooks/raw-git.ts` classifies shell commands by text
(no git spawn except reading a new commit) and is shared by every host: Claude
Code, Codex and Cursor through `handleHook`, OpenCode through
`v2/permissions.ts` and `v2/shell.ts`, Pi through `src/tools.ts`. It denies
gate bypasses only inside a Workit workspace, nudges routine raw mutations
(commit, push, PR create; never a read-only `gh pr view` or `git status`), and
records raw commits for the session (post-tool event; Cursor, which has none
registered, settles a pending marker on the next shell command). Keep the
classification string-only: hook latency is guarded by the bundle size test
and the Codex entry-size test in `test/workit-core/hooks/bundle.test.ts`.
`src/hooks/steering.ts` (`agentSteering`/`roleSteering`) is the one source
for how a role runs git: the SubagentStart text and the nudge set both read
it, so a Workit implementer or judge, already told at start, gets no git
nudge. Every `workit …` a hook text suggests must exist in the CLI registry
(`test/workit-core/hooks/steering-reachability.test.ts`).

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
- With `flag` (`--session`) on a host, only an issued id. A `--session` naming
  the shell's own derived session (OpenCode, Pi, Codex: alone or as
  `<lead>:<it>`) is a no-op, accepted and read as the shell's session (#427);
  a declared session (Claude Code) is still refused as `session_flag`.

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

Node floor (#424): the Claude Code, Codex and Cursor hooks are separate `node`
processes resolved from `PATH`, and a repo pinned to Node 16/18/22 by a version
manager puts an old Node there. Each launcher reads the minimum from its own
package's `engines.node` (an unreadable minimum never blocks). Only below it
does anything extra run, so a current Node costs nothing. The launcher then
looks for a Node that meets the floor (`core/node-resolve.mjs`: carried as a
byte-equal copy in `claude-code/bin/` and `cursor/hooks/`, imported into the
Codex bundle; a test holds the copies equal) in this order: (1) `WORKIT_NODE`;
(2) the absolute `process.execPath` that `workit setup` or `workit upgrade`
recorded in `<state dir>/node.json` (the state dir from `core/workit-paths.mjs`,
whose byte-equal copy sits beside each launcher, so `WORKIT_STATE_DIR` and XDG
apply; see [file locations](file-locations.md)), when it exists and was >= the floor;
(3) a directory-listing scan (no spawning, at most 200 entries per root) of
fnm (`$FNM_DIR`, `~/.local/share/fnm`, `%APPDATA%/fnm`), nvm (`$NVM_DIR`,
`~/.nvm`, nvm-windows `%NVM_HOME%`), volta, mise and asdf installs, highest
version wins. A hit re-runs the same launcher on that Node with stdin, stdout,
stderr and the exit code passed through; `WORKIT_HOOK_REEXEC=1` on the child
stops a second hop. With no hit the hook fails open (`{}`, exit 0) with
`[workit] <Host> hook unavailable: needs Node >=24, found <v>` on stderr, and
a `SessionStart` answers once with context that the hooks are off (Claude Code
and Codex `hookSpecificOutput.additionalContext`, Cursor `additional_context`);
other events stay quiet. The launcher code stays on Node 16 syntax and
`node:` builtins (a test runs it under the oldest installed Node when there is
one, else checks the source for newer syntax). The Claude plugin's `bin/workit`
shim does the same in POSIX sh when the PATH node is below 24. `workit doctor`
row `hook_node` reports which Node the hooks run on (pass: PATH node; info: a
recorded or scanned one; warn: none, hooks off), and the `no_session` unblock
hint names it as a likely cause. `WORKIT_HOOK_NODE_VERSION` overrides the
found version (tests). OpenCode and Pi hooks run in-process in the host's own
runtime, so the `PATH` Node does not apply to them. The Codex MCP entry
(`.mcp.json`) starts `bin/launch-mcp.mjs`, which does the same re-run for
`dist/launch-mcp.js` with stdio inherited (stdout stays pure JSON-RPC); with no
Node 24 it writes one stderr line and exits 1.

Owned CLI (#648): no host launcher spawns `workit` itself (each runs bundled
code), but the agent's shell runs whichever `workit` is first on `PATH`, and a
stale global copy can sit ahead of the owned launcher. `core/cli-locate.ts`
picks the CLI in one order: the owned launcher `<install root>/bin/workit`
(only when it carries the launcher marker), else the owned `current` entry run
by node, else a bundled CLI the caller names, else plain `workit` from `PATH`
(setups older than the owned install; `workit doctor` row `cli_installs` names
the fix). `useOwnedWorkitCli()` applies it to a process's env: the launcher's
`bin` first on `PATH` (moved there, never duplicated; `Path` and `;` on
Windows) and `WORKIT_CLI` naming it; with no owned install the env is left as
is. Its install root is the one copy: `workit-cli/src/install/paths.ts`, the
writer, re-exports it. Per host: the "Owned CLI on the agent's PATH" row.

N = native, P = partial, X = missing (the host has a mechanism workit does not
use yet), L = host limit (the host has no mechanism for it).

| Feature | Claude Code | OpenCode | Codex | Cursor | Pi |
| --- | --- | --- | --- | --- | --- |
| Session-start contract | N `SessionStart` | N per-call `session.hook("context")` (no start event) | N `SessionStart` | N `sessionStart` (fire-and-forget: may race the first turn) | N `session_start` / `before_agent_start` |
| Per-turn task context | N `UserPromptSubmit`, resent on change (core) | N every agent-loop call | N `UserPromptSubmit`, resent on change (core) | L: `beforeSubmitPrompt` cannot add context | N `before_agent_start`, resent on change (core) |
| Skill prompt nudge | N `UserPromptSubmit` | N session context | N `UserPromptSubmit` | L: no per-prompt context hook | N `before_agent_start` |
| Delivery (ship) nudge, skill-load recording | N | N | N (`SKILL.md` reads) | N (`SKILL.md` reads) | N |
| Branch policy / raw git deny + nudge | N `PreToolUse` | P: deny via permission effect; L: the nudge rides the result | N `PreToolUse` | P: deny works; nudge via `agent_message` (unverified); X: `postToolUse` context | P: `tool_call` blocks; L: the nudge rides `tool_result` |
| Raw delivery grant deny (#589: raw `git push`, tag push, `gh\|glab` PR/MR create/edit, release, merge against the target's grant; `hooks/raw-git.ts` `grantRefusal`) | N `PreToolUse` | N permission `evaluate` | N `PreToolUse` | N `beforeShellExecution` (deny) | N `tool_call` |
| Before-write gate | N `Edit`/`Write`/`MultiEdit`/`NotebookEdit` and shell writes | N permission `evaluate` | N `PreToolUse` on `apply_patch` (files from the patch) and shell writes | P `preToolUse` (a write with no readable path is gated as code) | N `tool_call` |
| Live-session guard (#274) | N `PreToolUse` (edits and shell); owner pid = the hook's parent process | N permission `evaluate` (edits and shell); owner pid = the server process, which runs every child session | N `PreToolUse` (`apply_patch` and shell); X: a per-command `workdir`, if the payload carries one, is not read | P `preToolUse` + `beforeShellExecution`; L: a subagent's tool events carry no parent conversation, so it is matched by the Cursor process | N `tool_call` (edits and bash); a worker's `WORKIT_SESSION_ID` names its lead |
| Issued-registry guard (#292): agent writes under `<state>/issued*` | N `PreToolUse` on edit tools and shell writes (also under `workit check -- bash -c`) | N permission `evaluate` (edits and shell) | N `PreToolUse` on `apply_patch` and shell; L: `write_stdin` and specialized shell paths are not interceptable | P `preToolUse` + `beforeShellExecution`; a write with no readable path is not matched | N `tool_call` (edits and bash) | 
| Heavy-command gate (#325, ruling mvid5onk) | N `PreToolUse` after every Workit gate: one simple heavy command (output shaping is not a chain: any redirects and one trailing `\| tail\|head\|grep …` filter stay outside the wrapped command, `workit check --heavy -- bun test 2>&1 \| tail -50`) gets `updatedInput` `workit check --heavy -- <cmd>` (the CLI caps the lease wait at 100 s in a Claude Code shell) with no `permissionDecision` (claude 2.1.306 applies it, then its own permission flow); a real chain (`&&`, `;`, several heavy parts) is denied with the split, which names the first heavy segment to run; a command a deny/ask rule names, or one only a `workit` allow would cover (not under `bypassPermissions`), runs as typed, with no note (#429). Rules read: managed-settings.json, `$CLAUDE_CONFIG_DIR`/`~/.claude/settings.json`, project `.claude/settings.json` and `settings.local.json`. L: `--settings`, `--allowedTools`/`--disallowedTools`, SDK `canUseTool` and server-managed policy are unreadable | N `execute.before` runs the permission hook's gates on the original, then rewrites one simple heavy command to `workit check --heavy -- <cmd>` (before the shell-session correlation notes it); `permission.evaluate` denies an allowed chain with heavy parts (ask and deny stand). Rules read: global, project and `.opencode/` `opencode.json(c)` up to the git top, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`: `permission.bash`/`shell` and every `agent.*.permission` | X: `PreToolUse` supports `updatedInput` rewrites (learn.chatgpt.com/docs/hooks), unused here; it denies one heavy command (shaped as above) with the exact `workit check --heavy -- <cmd>` and a chain with the split. Rules read: `~/.codex/rules/*.rules` and project `.codex/rules/*.rules` (`prefix_rule`); a rule it cannot parse means pass through. `workit setup` allows `workit check <test|lint|typecheck|build|format|docs>` and `workit lock status|wait` here, on Cursor and in Claude Code (never `check --`) | L: `beforeShellExecution` answers only allow/deny/ask: denies with the exact rewrite or the split. Rules read: `~/.cursor/cli-config.json` and project `.cursor/cli.json` `Shell(x)`. L: the IDE allowlist/denylist is unreadable | N `tool_call` after the gates: mutates `event.input.command` for one simple heavy command, blocks a chain with the split (Pi has no permission rules to read) |
| Hook deadline under load (#309); each host's deadline sits below its own timeout (`HOST_DEADLINES`; `WORKIT_HOOK_DEADLINE_MS` overrides all) | N: `hooks.json` timeouts 15 s (prompt, tool, subagent) and 20 s (`SessionStart`, `Stop`); deadline 8 s, 16 s for `SessionStart` and `Stop`; past it the hook answers `additionalContext` naming the skip | L: in-process plugin, no host timeout to beat (the server awaits the hook); no deadline applied | N: `Stop` `timeout: 20`, deadline 16 s; unset hooks keep Codex's default timeout (600 s per the Codex hooks docs, not read from the binary), deadline 45 s | N: no `timeout` set, so Cursor's 60 s default holds (`DEFAULT_HOOK_TIMEOUT_SECONDS`, cursor-agent 2026.09.26); deadline 45 s on every event, `subagentStart` included (`agent_message` on `beforeShellExecution`) | L: in-process extension, no host timeout; no deadline applied |
| `cd <dir> && workit …` normalised to `workit <verb> --cwd <dir> …` (#388, #297, `hooks/cwd-normalize.ts`) | N `PreToolUse` `updatedInput`, no `permissionDecision`, so `Bash(workit <verb> *)` matches; the verb goes first for an allowed verb (else `workit --cwd <dir> …`), and a plain `workit [--json] --cwd <literal dir> <allowed verb> …` is reordered the same way (`--session` before the verb is left alone); only `cd <literal dir> && workit … [2>&1] [\| tail\|head\|grep …]`, anything else (`cd $VAR`, `cd -`, `;`, `\|\|`, another segment) runs as typed; a heavy-gate rewrite wins (a workit command is never heavy itself) | N: the shell hook already strips the `cd` | X: `PreToolUse` supports `updatedInput` (learn.chatgpt.com/docs/hooks), unused here: nothing is denied or rewritten, the contract text (`workit <verb> --cwd <dir>`) carries it | L: `beforeShellExecution` cannot rewrite: contract text only | N: no permission layer, nothing to normalise |
| Host permission setup (#297, `admin/host-permissions.ts`; verbs in `hooks/delivery-verbs.ts`). L on every host: an allowed `workit git …` runs the repo's git hooks and config (husky, `core.hooksPath`, `core.sshCommand`) unprompted | N: `workit setup` merges `Bash(workit <verb> *)` allows, `ask` rules for bypass flags (second layer), `autoMode.environment`/`allow` lines and `env.CLAUDE_CODE_SHELL` into the user `settings.json` (never managed settings); the user-only calls (`WORKIT_USER_ONLY`: `release notes approve`, `grant set\|raise`, #615; `ledger void`, #759) get `ask` rules anchored at the verb (ask beats allow, also in auto mode; a `Bash(workit * …)` glob reads quoted text too, so it asked on a call that only mentioned the words, and a refresh drops the ones Workit wrote, #759) and the auto-mode text names them as not covered; an upgrade replaces the old text; the `PreToolUse` hook also answers `ask` for a user-only call with global options before the verb (`userOnlyWorkitCall`) and answers `permissionDecision: "ask"` for a workit call whose parsed words carry a literal bypass flag before `--` (`workitBypassFlag`; a word with an expansion is not read, L: `${F:---unverified}` is not asked, the merge grant and `--reason` gate it), and puts the verb before `--cwd`/`--json` so the rules match. L: plugins cannot ship permissions; a hook `allow` is still classified in auto mode. Auto mode (W2.12): the `Bash(workit <verb> *)` allows in `permissions.allow` cover the verbs in `WORKIT_ALLOWED_VERBS` (`git`, `pr`, `ci`, `stack`, `release`, `task`, `ledger`, `evidence`, `finding`, `decision`, `worker`, `verify-delivery`, `policy`, `doctor`, `help`) plus `workit check <name>` and `workit lock status\|wait`, and the one `autoMode.allow` line names the grant-gated delivery verbs (`workit pr merge`, `workit git push --force-with-lease` on the session's own branch, `workit release`, `workit pr reply\|resolve`) as authorized by the user's grants and the `autoMode.environment` line names `workit` as the user's delivery CLI; neither covers the user-only calls or a bypass flag. A hook that rewrites a call (`updatedInput`) is classified again, so the cwd note names the exact form to pass, and under auto mode the spawn hook denies with the exact args instead of rewriting | N: no write; `permission.evaluate` turns an `ask` into `allow` when every resource is only allowed Workit calls (never a user-only call, #615) with no expansion before `--` (the one place a Workit hook answers allow; config `deny` wins first) | N: Workit-owned `rules/workit.rules`, flat `prefix_rule` per verb, `grant` → `prompt`, plus a `prompt` rule for each user-only call (#615). the `PreToolUse` hook denies a user-only call whatever global options precede the verb (`userOnlyWorkitCall`). L: a prefix rule cannot see a later bypass flag or a `--cwd` before the verb; it matches argv words from the start, so a user-only call named only in an argument's text never prompts | N: `Shell(workit <verb>)` in `~/.cursor/cli-config.json` (prefix match, cursor-agent 2026.09.26 `matchesShell`). The hooks answer `permission` only for what Workit decides (#635): `deny`, `ask`, and `allow` on a `subagentStart` whose worker Workit assigned; a pass-through, a nudge (`agent_message` alone), a degraded payload and a `subagentStart` with no active task omit it, which cursor-agent 2026.09.26 treats as no answer (it acts only on `deny`/`ask`), so the user's allowlist and auto-run settings decide; L: the IDE's handling of an omitted answer is unverified. L: same prefix limits; `--session` before the verb does not match; the IDE `permissions.json` replaces the whole list, so it is left manual; the user-only calls are `permissions.deny` entries (#615) and the `beforeShellExecution` hook denies them with any global option placed before the verb (`userOnlyWorkitCall`) | L: no permission layer, nothing to write; the `tool_call` hook denies the user-only calls (#615) with any global option placed before the verb (`userOnlyWorkitCall`), then the CLI's TTY and agent-marker check stands; L: a command the shell tokenizer cannot analyze is not read |
| Session id without an env prefix | N: none needed | N: shell env set by the host | N: `CODEX_THREAD_ID` | N: Cursor puts no session id in the shell, so the addendum says `workit --session <id> …` (global flag, only before the command; `WORKIT_SESSION_ID` still works and the flag wins; on a host that checks the session the flag meets `sessionClaimRefusal` like the env var). | N: `PI_SESSION_ID` |
| Raw commit recording | N `PostToolUse` | N `execute.after` | N `PostToolUse` | P: settled on the next shell command; X: `afterShellExecution`/`postToolUse` | N `tool_result` |
| Branch-scoped worker assignment gate (#316) | L: no launch gate; a subagent is not tied to a worker assignment | N `execute.before` binds a native launch to the current branch's task; one unlaunched worker left on another task is rebound to it (assigned there, cancelled with a reason naming both tasks); anything ambiguous is denied with a branch-scoped hint | L: no launch gate | L: no launch gate | L: workers are supervised by workit, no native launch gate |
| Launch-to-assignment binding and concurrent launches (#640) | L: no launch gate; a subagent is not tied to a worker assignment | N: several `subagent` calls in one turn run concurrently (OpenCode 2.2.5 runs them in parallel; `test/opencode-v2` "concurrent subagent calls complete in one turn"). `execute.before` reserves, per call id, the free assigned worker the prompt is for (`v2/launch-match.ts`): a worker id in the prompt (`WORKER: <id>`), else the assignment whose objective or scope paths the prompt carries (the same brief assigned twice: the newer one), else the one its role (`ROLE:` line or agent type) picks; a launch that fits several equally is refused before anything is recorded, naming each worker, and a prompt naming a worker another call is launching is refused. The child binds by its call's result, or at `session.created` by its title (OpenCode 2.2.5 titles the child with the call's `description`; a duplicate description among open launches gets ` [<worker id>]` appended) | L: no launch gate | L: no launch gate | L: workers are supervised by workit, no native launch gate |
| Verifier/reviewer own session | N `SubagentStart` (`workit:verifier`, `workit:reviewer`) | N: child shell gets `WORKIT_SESSION_ID=<lead>:<child>` (`shell.hook("create.before")`), and a child without a worker records evidence and findings under it; native parent binding; X: `agent.transform` definitions | N `SubagentStart` (`workit-verifier`, `workit-reviewer` agent types); P: shipped read-only (`sandbox_mode`) agents the MCP launcher copies into `$CODEX_HOME/agents/` (L: codex-cli 0.160.1 plugins cannot register agents) | P: role markers; L: `subagentStart` cannot add context | N: supervised worker shell gets `WORKIT_SESSION_ID=<lead>:<worker session>`; L: no host subagents |
| Real session for verdicts (`forged_session` refusal) | P: subagent `<lead>:<agent id>` accepted only when SubagentStart issued it, with the token it handed that subagent (each id issued once; binding sticky per lead); L: the token sits in the subagent transcript on disk; L: anyone who can run the hook bundle can mint a new id and token; L: the lead's own id is the declared `WORKIT_SESSION_ID` (no host-set id in the shell; `CLAUDE_CODE_SESSION_ID` unused), so an inline colon-less id such as `<lead>-v<n>` is still declared; L: the issued-id record is per-user state files a deliberate write can forge | N `OPENCODE_SESSION_ID` (set by the shell tool); children `<lead>:<child>`; `WORKIT_HOST=opencode` without it is refused; L: removing both reads as a plain terminal | P `CODEX_THREAD_ID` for the thread; subagent `<lead>:<agent id>` only when SubagentStart issued it, with its token (L: unverified whether a subagent's shell gets its own thread id; `--as verifier` otherwise); `WORKIT_HOST=codex_*` without it is refused; L: the issued-id record is forgeable by a deliberate write | L: no session id in the agent shell and no `WORKIT_HOST`: declared, not checked | N `PI_SESSION_ID` (bash tool); workers `<lead>:<worker session>`; `WORKIT_HOST=pi` without it is refused |
| Exact verdict line at judge start (#271 S2a, `verdictCommand`) | N `SubagentStart` for `workit:verifier`/`workit:reviewer` (L: Claude Code subagents share the lead's environment, so no per-agent env var or file can carry the token; it stays on the line, #427): `workit ledger verdict <verified\|failed\|blocked> --kind <live\|unit> --branch <b> --session <lead>:<agent id> --token=<t> --how "…"` (`--kind review` for a reviewer); an id SubagentStart already issued gets no command, only "spawn a fresh verifier"; `--branch` is the checkout's branch, or `<branch>` on a protected branch or detached HEAD (ruling mvij5l86); implementers get none | N `<workit-verdict-line>` in the child's `session.hook("context")` system parts, for any child but an implementer worker (no Workit agent types name a judge, ruling mvij5le6); no `--session`/`--token`: the child shell already acts as `<lead>:<child>` | N `SubagentStart` for `workit-verifier`/`workit-reviewer`: the same line with no `--session` and no `--token` (the child's `CODEX_THREAD_ID` is its own id; nothing is issued, #427) | L: `subagentStart` cannot add context, and judges are marked in the task text, not by agent type (ruling mvij5lpm) | L: supervised workers have no shell tool (`--tools` allowlist without `bash`), so they cannot run `workit ledger verdict`; reviewers record evidence and findings (ruling mvij5ljz) |
| Bounded task brief for children (`task inspect`, #342) | N: CLI `task inspect` prints the brief (no native task tool; subagents call the CLI) | N: a child with no worker may call `workit_task` `inspect` (`v2/child-identity.ts`) and gets the brief; its other task actions stay denied | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: a worker's `workit_task` `inspect` returns the brief; L: Pi has no host subagents beyond workers |
| Decider call (#335: one fix round and one recheck, then a decider; `ledger decision --by decider`) | N: skills plus the host-neutral CLI; second decider on another model via `model` on the Agent call | N: skills plus the CLI; the plugin's `execute.before` sets the `decider` role model on the `subagent` spawn | P: skills plus the CLI; L: one decider, the host picks no per-spawn model | N: skills plus the CLI; second decider on another model via the optional `model` argument of the Task tool (cursor-agent 2026.09.26 bundle) | P: skills plus the CLI; L: one decider, the host picks no per-spawn model |
| Review lanes and `verification: proportional` (#333: lane from the diff in core, read by `pr merge`, `stack land`, the Stop hook and `policy assess`) | N: core gates and the Stop hook; a focused-lane verifier on the cheap tier via `model: sonnet` on the Agent call | N: core gates and the Stop hook; the plugin's `execute.before` sets the `verifier` role model on the `subagent` spawn | N: core gates and the Stop hook; L: the host picks no per-spawn model, so focused and full verifiers share one | N: core gates and the stop hook; cheaper verifier via the optional `model` argument of the Task tool | N: core gates and the Stop hook; L: the host picks no per-spawn model |
| Implementer spawn gate (#432, `hooks/spawn-gate.ts`) | N `PreToolUse` on Agent/Task: `isolation` is dropped through `updatedInput` on every agent type (#654), except under auto mode, which refuses a rewritten spawn: there the spawn is denied once with the same args without it (retro 2026-11-07 R1), and a `workit:implementer` prompt with no made `WORKTREE:` line (no brief) is denied with `workit fanout worktree create <slice>`, then `workit fanout brief <slice>`, even for a single slice. The launcher fast path answers a briefed implementer or another type that names `model` only when `workspaces.json` configures no role models, and loads the runtime for any spawn with `isolation` and an implementer spawn with no `WORKTREE:` line | L: no hook runs before a child session starts; the lead's brief is the only gate | L: no pre-spawn hook and no host worktree isolation to strip; the copied `workit-implementer` agent and the brief carry the rule | L: implementer subagents are denied at `subagentStart`, which sees no brief | L: no host subagents and no host isolation; the lead's brief is the gate |
| Standing-order deltas and the stop line to running workers (#320, `hooks/standing.ts`; the automatic stop on memory/CPU pressure waits for #326) | N `PreToolUse` `additionalContext`, once per revision; the subagent is `agent_id` under the lead's `session_id` with a Workit `agent_type` (`workit:implementer`, `workit:verifier`, `workit:reviewer`; another type, such as an Explore or inventory agent, gets orders only on a slice branch, W2.27), its baseline taken at `SubagentStart`; X: only the matchers workit registers (Bash, PowerShell, edits, Skill), so a worker that only reads sees it on its next one; the launcher fast path loads the runtime only when `standing/rev` differs from the agent's seen file | N `<workit-standing>` in the child's `session.hook("context")` system parts on every model call while the change stands (the system context is rebuilt per call, so it never stacks); the child is its `parentID`, its baseline its first call; L: the context hook names no agent type, so every child of the lead counts as a worker (W2.27) | P `PreToolUse` `additionalContext` (matcher `*`), baseline at `SubagentStart`; L: unverified that a subagent's `PreToolUse` carries the lead's `session_id` with its `agent_id`; a thread on a slice branch is matched by branch | P `agent_message` on `beforeShellExecution` (unverified that the model reads it) and `additional_context` on `preToolUse`; L: a subagent's tool events carry no parent conversation, so only a session on a slice branch is a worker (implementer subagents are denied anyway) | P: the worker's next `tool_result` (L: `tool_call` cannot add context); a supervised worker acts as `<lead>:<worker session>` and is seeded at launch |
| Worker tool-call budget (retro P9, `hooks/budget-signal.ts`; TIMEBOX `N tool calls`, default 120) | N: a lead's Agent/Task spawn that passes the spawn gate queues N or an explicit none (a denied spawn queues nothing), `SubagentStart` takes the head entry of its `subagent_type` and binds it to `agent_id`, `SubagentStop` deletes the agent's budget files (leftovers age out after 7 days), no warning for a worker that stops with background commands still running (W2.35, L: claude 2.1.318 `SubagentStop` `background_tasks` lists the in-flight work of the whole session with no owning agent, so a worker's own tasks cannot be told from the lead's; the agent prompts carry the rule instead), the launcher appends one byte per `PreToolUse` without loading the runtime (Read, Grep and Glob gain a matcher for this) and only the Nth call loads it: one `additionalContext` line at N, again at 2N; never a deny. L: SubagentStart does not carry the prompt, so the spawns of one `subagent_type` are matched to agents in the order they start; a tool no matcher names is not counted | P: the lead's `subagent` call queues N, the child binds it on its first `execute.before` and each call counts; the line stands in the child's `<workit-standing>` system part from N on (the system context is rebuilt per call, so it is not a one-time line) | P `PreToolUse` `additionalContext`: a lead's non-shell, non-edit tool input that names an agent type or carries a `TIMEBOX:` line queues N or none, `SubagentStart` binds it, `SubagentStop` deletes it; L: unverified which Codex spawn tool field carries the prompt | X: not wired | P: a supervised worker binds N from its launch prompt or objective; the line rides the Nth `tool_result` (L: `tool_call` cannot add context); a Pi session Workit did not launch is not budgeted |
| Implementer worktree guidance (#310) | N `SubagentStart`: the lead's `workit fanout worktree create` worktree, `workit --cwd <worktree> git\|check …` one verb per call; the agent has no `isolation` (Claude Code's refused every unverifiable command and every wrapped git, and cannot be turned off). An implementer still spawned with `isolation: "worktree"` (cwd `.claude/worktrees/agent-<id>`) gets the plain-git text instead | X: the `worktree` domain is unused | P `SubagentStart` text and the shipped `workit-implementer` agent; L: no native worktree isolation, the lead makes one | P: implementers denied at `subagentStart` | L: no host subagents |
| Implementer worktree confinement (#310, `hooks/worktree-confine.ts`) | N `PreToolUse` (edits, shell writes, mutating raw git, `workit --cwd <dir> git commit\|branch`) for `agent_type` `workit:implementer`: the first change inside a worktree whose admin dir holds the fanout token binds the agent (`<state dir>/worktree-bind/`, keyed by session and agent, so it holds whatever the hook cwd; a `worktree.bound` row); after that a change outside it is denied naming it, before that one outside every Workit worktree. Always denied: the lead's worktree, ref, config and fan-out changes (`git worktree` other than `list`, `update-ref`, `symbolic-ref` writes, `branch -d/-D/-f/-m/-M/-c/-C`, `tag -d/-f`, delete/`--mirror`/`--prune` pushes, a force push with an explicit refspec (`git push --force-with-lease` alone stays), any push refspec with `:` or a leading `+`, `replace`, `notes` writes, `filter-branch`, `gc`, `prune`, `repack`, `reflog` other than `show`, `submodule` other than `status`, `sparse-checkout`, `config` and `remote` writes, `stash drop/clear`, `workit fanout plan\|worktree`, also behind workit's global options such as `--json`, `--cwd`, `--session`). Writers the edit analysis cannot read (`sh\|bash -c` scripts, with shell options before `-c`, are read like `workit check -- bash -c`, `busybox` is a prefix; `$(…)`; `unlink`, `chmod`, `rsync`, `find -delete\|-exec <writer>`, `xargs <writer>`, `awk -i`, `curl` writes: `-o` and `-O` under `--output-dir`, `-c`, `-D`, `--trace[-ascii]`, `--stderr`, `--libcurl`, `--hsts`, `--alt-svc`, `--etag-save`, `-w '%output{…}'`, also as any long-option prefix curl accepts; `mkfifo`; `wget` `-O`, `-o`, `-a`, `-P` or its run dir; `tar` `-x` (into `-C`) and the archive `-c\|-r\|-u` writes; `unzip` (into `-d`); git `init`, `clone`, `format-patch` (`-o`), `archive -o`, `bundle create`, any `--output`, `config` writes (`--global`, `--system`, `--file`), `fetch`, `gc` and `branch` writes, under `-C`, #790) count as a change in their directory (or their named files), and a denial for one names the command and the directory it runs in (#772), and `ln` sources are judged, so a link inside the worktree cannot point outside it. An inline interpreter script (`python -c`, `node -e`, `ruby -e`, `perl -e`) is judged by the paths it names (#744): its run directory counts as a write target, plus every absolute, `~` or `..`-climbing path in its text, options, arguments and env prefix; a relative `require`/`import` resolves to the run directory, and a path Workit cannot resolve is denied, so it passes only when run from the worktree, its scratch or a temp dir and naming no path outside them. Variables (#744, #772): a plain `NAME=<literal>` set earlier in the same command, `$(mktemp …)` (the path it prints), `$PWD` after a literal `cd`, `pushd <dir>` or `popd` that starts its own `;` or newline segment and lands in an existing directory (not after `&&`/`||`, in a pipeline or `&`, through `command`/`builtin`, with CDPATH set or a function defined), and a `for` over literal words or words built from those, none holding whitespace or a glob, resolve, also in `workit … --cwd $W` and `workit check\|lock run --cwd $W`; a loop or conditional untrusts only the names assigned in its body, while `case`, `select`, functions, an IFS assignment (other than `IFS= read`) and a command-word `eval`/`source`/`declare` untrust every variable. `curl -K <config>`, `curl -w @<file>` and a command named by a variable (`$c -o …`) are unresolvable. A write through a variable Workit cannot resolve is denied naming it, with the command reprinted as `<absolute path of $T>` to spell out; a command substitution (`F=$(grep …)`) stays denied, naming it and the command to run first, with the assignment left out of the retry. L: `W=$PWD` after `&&` or `||` is not followed (the shell analysis does not record which operator a command follows). A write after a `cd`, `pushd` or `popd` whose target Workit cannot resolve (`cd -`, an unresolved variable, a glob, `$(…)`, `command cd`, `pushd` with no directory, `+N` or an option, `popd` with an argument, any `cd` inside a loop or conditional body) is denied until the path is spelled absolutely, with `git -C <worktree>` or `workit --cwd <worktree>`. Files outside any repository are host policy; an agent in a real linked worktree at `<repo>/.claude/worktrees/agent-<its id>` is left to the host (a look-alike directory, or a `.git` file naming another worktree's admin dir, is not); the launcher fast path never answers an implementer's edit, writing shell command or one of those writers, so those load the runtime. L: a script file an interpreter runs (`python script.py`, `node x.mjs`) is not judged, a raw `git -C $W …` is not resolved through the variable (X, follow-up), nor are writers whose output path the analysis does not read: `cp -s\|-l` (links), `docker cp`, `ed`, `ex`, `vim -c`, `sqlite3`, and any other program that writes where its arguments or its own script say. This is a guard against hand edits, not a sandbox; the merge gate and non-author verdicts catch an out-of-scope diff. Read-only git is never denied | L: the permission `evaluate` hook gets the child session but no agent type, so a child is never bound to a worktree (a worker assignment could carry one: follow-up) | P `PreToolUse` for `agent_type` `workit-implementer`, same rules (the launcher loads the runtime for every implementer tool call); L: unverified that a subagent's `PreToolUse` carries `agent_id` and `agent_type` (`agentIdOnTool: partial`) | L: implementers are denied at `subagentStart`, so none runs to confine | L: no host subagents; supervised workers carry no agent type |
| Verifier/reviewer scratch confinement (#790, `hooks/worktree-confine.ts`) | N `PreToolUse` (edits, shell writes, mutating raw git) for `agent_type` `workit:verifier` and `workit:reviewer`: every write target must lie in `.workit-scratch/` at the root of a checkout of the hook cwd's repository (the lead checkout or one of its linked worktrees, resolved through symlinks; another repository's scratch is outside); any other, in a repository, the home dir or a temp dir, is denied naming the scratch dir of the hook cwd's checkout, with the same strict shell analysis as an implementer's (writers it cannot read count in their run directory, `ln` sources are judged, an unresolvable variable or `cd` is denied; git ref, config, worktree and push changes count in their repository). Also denied: an unquoted heredoc whose body holds `$(…)` or a backtick (`$((…))` arithmetic is not one; the shell runs it while writing the file, incident mwbalrwk); a shell reading a heredoc script (`bash <<'EOF'`, `sh <<< …`) whose script writes outside; and, saying to write the case to a scratch file and dispatch it from a test, a script Workit cannot read: a shell or interpreter fed by a pipe (`… \| bash`, `\| sh -s`, `\| env bash`, `\| python3 -`), an interpreter reading stdin (`python3 <<'EOF'`, `node <<'EOF'`, `bash /dev/stdin`, `. /dev/stdin`), `source <(…)`, `bash <(…)` and `eval`, also inside `$(…)`, `-c` scripts and `workit check --`. Workit verbs follow a judge table, so a new verb is denied: `workit check`, `dir`, `help`, `test-audit` (not `--mutate`), `ledger verdict\|finding\|list\|check\|ruling`, `pr status`, `ci wait\|logs`, `fanout status\|brief`, `models show` and `lock status` pass, read past wrappers (`time`, `env`, `exec`, `!`, compound commands, `xargs`, `find -exec`, function bodies, alias bodies and uses, so `alias w=workit; w gc` is read as `workit gc`) and through `npx`/`npm exec`/`bunx`/`pnpm dlx` of `@workit-dev/cli`, `bun run workit` or `node`/`bun` on the CLI entry; `-h`/`--help` counts only right after `workit` or the verb, and any `--mutate` form is denied; reads pass; a judge's writes neither meet nor claim the live-session guard, since they stay in scratch; the launcher fast path never answers a judge's edit, writing command or one of those forms. L: the guard stops accidental writes; escapes through other tools are the OS sandbox's (#400): a script file in scratch the judge runs (`bash case.sh`, `bun case.ts`, `. case.sh`), a package script (`bun run`, `npm install`), `awk` `system()` or `print >`, `sed` `w`/`e`, `make -f /dev/stdin`, `vim`/`ed`/`ex`, `fish`/`tcsh`/`pwsh`/`deno`/`lua`/`python -m`, `git -c alias.x='!…'` or a pager, `git tag`; `gh`/`glab` calls are not judged | L: the permission `evaluate` hook gets no agent type; judge workers are read-only by assignment only | P `PreToolUse` for `workit-verifier`, `workit-reviewer`, same rules (the launcher loads the runtime for every judge tool call; the agents also run in a read-only sandbox); L: `agentIdOnTool: partial`, as for implementers | L: `subagentStart` role markers only; no per-subagent tool hook to confine | L: no host subagents; a supervised judge worker gets read tools and Workit's only (no shell, write or edit: `worker.ts` `roleTools`) |
| Worktree dependencies (#310, `worktree-deps.ts`) | N: `workit fanout worktree create` mirrors the main checkout's git-ignored `node_modules` (and `*/node_modules`, `*/*/node_modules`) one level deep: relative links (workspace packages, `.bin`) resolve inside the worktree, installed packages link to the main checkout's; skipped with a note when git does not ignore `node_modules`. Measured on this repository: 866 entries in 18 ms, against 342 ms for a warm-cache `bun install --frozen-lockfile` | N: same CLI | N: same CLI | N: same CLI | N: same CLI |
| Role models (#395, #654: `models.roles`, `fanout.tierModels` as implementer tiers; `workit models show` says per host whether each role is enforced or advisory; L on every host: `models.lead` is advisory, no hook sets a session's own model) | N: the PreToolUse hook sets `model` and `effort` on an Agent spawn (#654): outside auto mode through `updatedInput`, whose note names the exact `model` and `effort` to pass next time (W2.21); under auto mode (hook input `permission_mode: "auto"`), which refuses a rewritten Agent call, a spawn that lacks its role's values is denied once with the exact args to pass (`subagent_type`, `model`, `effort`, `run_in_background` and every other arg kept; description and prompt as written), and the retry that names them runs untouched (retro 2026-11-07 R1). A spawn that already passes its role's model and effort is untouched in every mode. A configured role model wins over a model the lead names unless `models.allowLeadOverride` is true, and the note or deny says so; a built-in default applies only to a spawn that names no model; a full Claude id (`claude-sonnet-5-5`) is applied as its family alias, an unknown value warns and the spawn runs as written; a `general-purpose` spawn takes `models.roles.default`, or the role a `ROLE: <role>` line in its prompt names (`workit models show --report` lists what ran). Before the first spawn the lead gets the values: the SessionStart contract (`invariantBootstrap({ cwd, host })`) has one "Agent spawn model/effort" line for every agent type (built-in defaults when unset: fable/high decider, opus hard, sonnet standard and verifier, haiku mundane/explore/babysit), and the fanout brief for a Claude Code lead has a `SPAWN:` line and a `verifier SPAWN:` line with the exact Agent args, `run_in_background: true` included; L: a user `~/.claude/agents/<name>.md` cannot override `workit:verifier` (plugin agents are namespaced, a different name), so the per-call model is the mechanism | N: the plugin's `execute.before` sets `model` (`providerID/modelID[#variant]`) on a fresh `subagent` spawn from `models.roles`, with the same lead-override rule and note (delivered on the lead's next context build); a continuation (`sessionID`) keeps its child's model; a value that is not `provider/model` warns and is skipped; no permission layer re-checks a plugin-set input, so nothing is denied and the brief has no `SPAWN:` line (retro 2026-11-07 R1 is Claude Code only) | N: `model` and `model_reasoning_effort` written into the copied `workit-*` agent TOMLs only for a configured role (the implementer only when its tiers agree); L: a value in the file overrides spawn values; `explore`, `default`, `decider` and `babysit` are advisory (no agent file or spawn hook carries them) | P: the skills and brief name the model for the Task tool's `model` (the brief's `model:` line; the `SPAWN:` line and the contract's spawn args line are Claude Code's Agent tool syntax); L: role models are advisory: no Cursor hook can change a spawn's input, and Workit ships no Cursor agents, so no agent-file `model:` | N: `--model`/`--thinking` on a supervised worker for a configured role, ambient (no flags) otherwise; L: `verifier`, `default`, `decider` and `babysit` are advisory (no host subagent to set them on) |
| Usage-limit fallback (#655: a role or `models.lead` value may be an ordered list; `core/model-fallback.ts` marks a provider exhausted per user until the reset parsed from the limit text, else `models.limitWindow`, default 5h; the first model whose provider is not exhausted runs, the primary again after the reset; `workit models show` lists exhausted providers and resets; L on every host: no hook switches a running session's own model, so a lead on an exhausted provider gets a one-line switch notice naming the next `models.lead` model) | N: the Agent `PreToolUse` hook reads the tails of this project's transcripts written in the last 30 minutes; a transcript ending on an API error that names a usage limit (`You've hit your weekly limit · resets 7pm (America/Santiago)`, 5-hour, Opus/Sonnet limits per family) marks Anthropic exhausted, and the note on that spawn tells the lead to re-dispatch the dead worker once (a second death of the same prompt says not again); L: Claude Code runs only Anthropic models, so a role falls back only to another Claude family on a per-family limit, and the lead hears of a dead worker on its next spawn (no PostToolUse on Agent is registered). `SubagentStop` (W2.19) marks the provider exhausted the moment a worker stops when its `last_assistant_message` (at most 1000 characters) is a usage-limit error, so the next spawn already falls back; the launcher loads the runtime for a stop only when that message mentions a limit, quota or 429 | N: `execute.after` on a `subagent` call reads its error (or a short result) for a usage limit, marks the provider of the model it ran on, queues the re-dispatch note for the lead, and the next `execute.before` of that role sets the next model; the lead's context build adds the switch notice once per exhaustion | P: the agent TOMLs are written at launch, so a fallback applies from the next session start; L: no hook sees a subagent's error, so nothing marks a limit on Codex (`workit models show` still names the fallback from a limit another host recorded) | L: advisory: no Cursor hook can change a spawn or see its error; `workit models show` names the model to pass | P: a supervised worker for a configured role gets the fallback model at launch from the shared store; L: no hook reads a worker's error, so Pi marks no limit itself |
| Contract re-sent once after a mid-session model switch (#435, `hooks/model-switch.ts`) | L: no hook reports a `/model` switch (`SessionStart` sources: startup, resume, clear, compact) | N `<workit-model-switch>` system part (bootstrap or worker context plus task context) on the first `session.hook("context")` call whose `model` differs from the session's last | N: every hook input carries `model`; `UserPromptSubmit` adds the contract when it differs from the session's last (kept in the session marker) | L: `beforeSubmitPrompt` cannot add context | N `model_select` marks the session; the next `before_agent_start` leads with the contract |
| Same failing Workit call twice in a row (#435, `hooks/repeat-failure.ts`): the error ends `Same call failed twice: <corrected call>` | X: `PostToolUse` could escalate a repeated `workit …` failure, unused | N: tool errors (the `Example:` payload, else `details.guidance`) and `workit …` shell output (the `unblock`) | N: MCP tool errors (per server process); X: `PostToolUse` shell output | N: MCP tool errors (per server process) | N: tool errors and bash `workit …` output |
| Compaction restore | N `SessionStart` source=compact | N `session.hook("compaction")` | N `SessionStart` source=compact | P (L: `preCompact` only shows a user message) | N `session_compact` |
| Session trailer on raw commits | N: prepare-commit-msg hook installed by `workit doctor --fix` (via git) | N: prepare-commit-msg hook (via git) | N: prepare-commit-msg hook (via git) | L: no session id in the agent shell, so the trailer only appears when `WORKIT_SESSION_ID` is set | N: prepare-commit-msg hook (via git) |
| Workspace `trailers: false` (no Workit-Session trailer, ledger authorship) | N: `workit git commit`, the hook helper (asks `workit git trailers`), `SubagentStart` text for isolated implementers | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) | N: same CLI and hook (via git) |
| Extra trailers in the same commit (`workit git commit --trailer`) | N: the contract names it; isolated implementers use `git commit --trailer` | N: contract (bootstrap) | N: contract (`SessionStart`) | N: contract (`sessionStart`) | N: contract (`before_agent_start`) |
| Stop control | N `Stop` (`decision:block`, `stop_hook_active`); a subagent's stop is never blocked | P `session.idle` event, continued with `session.synthetic({resume: true})` only after `outcome: succeeded` (L: no stop hook or loop guard; resume semantics inferred from @opencode/client 2.0.18) | N `Stop` (`decision:block`, `stop_hook_active`) | N `stop` `followup_message` (`loop_count`, registered with `loop_limit: 1`; last message read from `transcript_path`) | N `agent_end` + `sendMessage({triggerTurn})`, never after `stopReason` `aborted`/`error` (L: no host loop guard; the extension keeps one). L on every host (#394): no non-blocking notice channel at a stop, so at endpoint `pr` a PR with no verdict yet stops silently; the verdict ask waits for `green`/`merged`. A live `workit ci wait` on the PR and head (#748) lets the stop through instead of a block: Claude Code (`systemMessage`) and Cursor show the in-flight notice; OpenCode, Codex and Pi allow it with no notice |
| `/wk-*` aliases | X: plugin commands are namespaced (`/workit:<name>`) | P `command.transform` (prose, not `prompt.skills`) | L: no plugin slash commands (`$workit-<name>`) | N `commands/wk-*.md` | N `registerCommand` |
| Heartbeat / doctor | P plugin check; N `claude_session_plugin` (running `claude` processes older than the installed plugin, via `ps`; L: not on Windows) and a once-per-session restart line from the hook | P version check | N version, hook-trust (`codex_hooks`) and agents (`codex_agents`) checks | N launcher heartbeat | N `pi_extension`: missing, not loading, older than workit |
| PR issue links (`pr create --issue`, #324) | N: CLI flag (no native PR tool: delivery is the CLI's `pr` verbs under grants) | N: CLI flag; the plugin's tools are the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; MCP advertises the task families only | N: CLI flag; `workit_context` and the task families are its only tools |
| ytrack agent skill (youtrack-cli #16, `core/ytrack-skill.ts`): with YouTrack in use, `workit setup` and `workit upgrade` run `ytrack skill install --dir <root> --json` for each host with Workit; doctor `ytrack_skill`; uninstall removes only recorded dirs | N `$CLAUDE_CONFIG_DIR/skills`, default `~/.claude/skills` ([Claude Code skills](https://code.claude.com/docs/en/skills)) | N `$XDG_CONFIG_HOME/opencode/skills`, default `~/.config/opencode/skills` ([OpenCode skills](https://opencode.ai/docs/skills/)); OpenCode also reads `~/.claude/skills` and `~/.agents/skills`, so it can list the skill twice | N `$CODEX_HOME/skills`, default `~/.codex/skills`: still a user root, though the docs now name `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)); Workit keeps `~/.agents/skills` free because OpenCode, Cursor and Pi read it too | N `~/.cursor/skills` ([Cursor skills](https://cursor.com/docs/context/skills)); Cursor also reads `~/.claude/skills` and `~/.codex/skills` | N `$PI_CODING_AGENT_DIR/skills`, default `~/.pi/agent/skills` (pi-mono `packages/coding-agent/src/core/skills.ts`, the user `skills` dir under the agent dir) |
| Continuing a reported worker (#313) | L: no continuation gate; a subagent turn is resumed natively, so the lead follows `fanout brief --mode resume` by convention | N: `subagent` with a `sessionID` is refused (`delegation_lineage_denied`) unless the worker is running or its worktree has uncommitted changes; the refusal prints `workit fanout brief <slice> --mode resume` | L: no continuation gate | L: no continuation gate | L: no host subagents |
| Owned CLI on the agent's PATH (#648, `core/cli-locate.ts`) | N: the plugin's bundled `bin/workit`, unchanged | N: `shell.create.before` adds `opencodeShellEnv()` to every agent shell's env (`src/cli-path.ts`); a V2 build with no shell domain applies it to the plugin process, whose shells inherit it | P: the hook entry (`hooks/launcher.ts`) and the MCP server (`scripts/launch-mcp.ts`) apply it to their own process, so what they run or probe is the owned CLI. L: no hook or MCP answer changes the agent's shell env | P: the hook process (`hooks/workit-hook.ts`) applies it to its own env. L: no hook changes the agent's shell env | N: the extension applies it to Pi's process env when it loads (`src/cli-path.ts`); the bash tool inherits it |
| `base_red` cause on `pr merge` (#750, `forge/merge-gate-base-red.ts`): the previous base run decides likely flaky (unblock `workit ci rerun --ref <base> --check "<job>" --reason flake`), `<base>` is broken (no rerun) or unknown | N: CLI | N: CLI | N: CLI | N: CLI | N: CLI. On every host the classification is GitHub-only: GitLab always gets `unknown` and the generic `--failed` rerun hint (X: `Forge.commitChecks` for GitLab, follow-up) |
| Configured checks at judge start (#751: `ledger verdict verified\|tests-verified` refuses `check_missing` without a fresh passing local run or green PR CI on the head; the refusal is the CLI's on every host) | N `SubagentStart` for `workit:verifier`/`workit:reviewer` lists each configured check as `workit check <name>`, "or cite green CI on the head" | X: the child's context hook could carry the list, unused; the CLI refusal names the checks | N `SubagentStart` for `workit-verifier`/`workit-reviewer`, same list | L: `subagentStart` cannot add context; the CLI refusal names the checks | L: supervised workers have no shell tool, so they record no verdict |
| Deslop fresh-eyes no-comments pass (#754, `focused` lane and up; [review.md](../guides/review.md)) | N: the `workit:reviewer` agent gets the diff and the keep list | N: a child session | N: the `workit-reviewer` agent | P: a Task subagent marked `ROLE: reviewer`; L: `subagentStart` cannot add context, so the diff and keep list ride the task prompt | P: a supervised worker; L: supervised workers have no `bash`, so the lead runs `workit deslop scan --diff` and `workit test-audit` and passes their output |
| Local weak-model bench (#749, `scripts/eval/run.ts`, [eval.md](eval.md)) | N: each case runs as a headless `claude -p` with `--plugin-dir` on the checkout, graded from the transcript's tool calls | X: no runner yet (follow-up) | X: no runner yet (follow-up) | X: no runner yet (follow-up) | X: no runner yet (follow-up) |
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

Hook run limits (#433):

- **Runs are counted per host and native event.** The hook process records
  each run in `<state dir>/hook-runs/<host>__<event>.json` (last time and a
  count; best effort, one small write, no spawn), and `workit doctor`
  (`hook_runs`) shows the last `SessionStart` and `PreToolUse` per host, so
  "zero hook events" separates a host that never fires its hooks from one that
  fires them silently. The Codex launcher's quiet path counts `PreToolUse`
  (not `PostToolUse`); the Claude Code launcher's fast path does not count
  (L). Counting starts with this version, so an old run is not shown.
- **Codex CLI** (probe 2026-10-27, codex-cli 0.164.0-alpha.11.1): `PreToolUse`
  sees and denies both a plain shell command and the nested
  `tools.exec_command` inside the code-mode `exec` tool.
- **Codex Desktop** (U): hooks run (`SubagentStart` context seen), but no
  rollout shows a `PreToolUse` block either way, so nested `exec` coverage is
  unverified; a manual Desktop probe is pending with the user.
- **Grant coverage.** `workit doctor` (`claude_grant_rules`,
  `codex_grant_rules`, `cursor_grant_rules`) warns, with the `workit setup`
  fix, when a host's allow rules (and Claude Code's `autoMode.allow` text) miss
  a verb the workspace grants (`workit git push`, `workit pr create`,
  `workit pr merge`) or the `workit check <name>` and `workit lock status|wait`
  lease verbs; Claude Code reads the user and the project settings files.

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

Heavy-check lease limits (#729, `core/resources.ts`), the same on every host:

- **Linux and macOS:** the lease records the check's process group with its
  leader's start time (`pgidStart`). Once workit is gone, the group holds the
  lease past its age bound only while that same leader leads it; a pgid led by
  another process is stale. A nested `workit check` reuses `WORKIT_LEASE` from
  an ancestor, or, when the ancestor chain broke (workit killed, a daemon
  re-parented to init), from the proven group it runs in. That group read is
  Linux-only (`/proc`); macOS has no cheap ancestor walk and accepts the lease
  as before.
- **Windows (L):** there are no process groups and no process start time, so
  `pgidStart` stays null, a lease outlives its workit only within its age
  bound, and a nested check reuses the lease as before.
- **Older leases** (no `pgidStart`) keep the earlier rule: their group holds
  them only within the age bound.

Host-approval channel limits (proposed, not shipped:
[host-approval.md](../workit-next/host-approval.md); #419, #649, #768, #774).
Every host keeps the terminal fallback: the spec's proposed approve verb, run
by the user at a real TTY.

- **Claude Code:** no hook sees a rejected prompt, so a no leaves the request
  to expire (L). U: whether a hook `ask` prompts under `bypassPermissions`;
  until probed, that mode records nothing.
- **OpenCode:** U: whether a `subagent` spawn passes `permission.evaluate`;
  until probed, a model override uses request and approve.
- **Codex:** the hook can deny but not ask; prompts come only from prefix
  rules, so inline asks deny and name the request id (L). U: the
  `permission_mode` values under `approval_policy = never` and how a "don't
  ask again" answer caches; fallback-only until probed.
- **Cursor:** `afterShellExecution` is offered but not registered (X). U:
  whether auto-run skips an `ask`; fallback-only until probed.
- **Pi:** no UI in print or RPC mode (`hasUI` false), so fallback only (L).

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
