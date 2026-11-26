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
(`showIssue`, `createIssue`, `addComment` with optional `--attach` files,
`addWorkItem`, `attachFiles`, `applyCommand`, `ownEntries` (the current
user's own comments or work items on an issue), `supports` (a `--help` probe for
`issue comment --attach`, `issue attach` and `auth paths`), and `texts` for the
marker read-back), and its only implementation, `ytrackBackend`, runs
`ytrack … --json` (`core/youtrack-ytrack.ts`). It sets `YTRACK_HOST` from
`youtrack.json`'s `baseUrl` and passes no token. Every ytrack it runs gets
`YTRACK_NO_UPDATE_NOTIFIER=1` and `YTRACK_NO_AUTO_UPGRADE=1` (`YTRACK_QUIET_ENV`), so
Workit never starts ytrack's release check, its background upgrade or the skill
refresh that upgrade brings.

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
so no token read comes back. Every write asks the user first (#780, #864):
with `youtrack.writes` ask (the default) a plain `workit youtrack
note|time|meeting|update|create` call is asked on the call itself where the
host can (Claude Code `PreToolUse`, Pi's TUI dialog; see the host-approval
limits below) and posts in that call; otherwise the verb and `ytrackWrite`
(`defaultOperations`, which PR backlinks use) consume a terminal
`youtrack-write` approval (`consumeApproval`), else record one request per
text and post nothing; `auto`, which the user sets, keeps the
`WORKIT_YT_WRITE=1` gate (`youTrackWriteGate`). A pending PR backlink posts
once on the next `workit pr create` or `workit pr edit` of that PR.

`workit youtrack update <ISSUE>` puts a comment (with `--attach` files), time
and commands (`--state`, `--command`) on one issue under one `youtrack-write`
approval and runs them in that order, stopping at the first failure. It is a
CLI verb, so all five hosts get it with no adapter code. `ytrack auth paths`
(youtrack-cli hosts.yml) maps each workspace glob to its YouTrack host so an
agent's own ytrack there reaches it: `core/youtrack-paths.ts`
(`reviewYtrackPaths`) feeds the doctor's `ytrack_paths` row and the setup
preview's `ytrackPaths`, whose `--add` calls Apply runs; neither touches
`workspaces.json`.

A raw `ytrack` write an agent runs itself asks first too (`hooks/ytrack-guard.ts`,
wired in `hooks/handle.ts`): `issue comment|create|edit|update|delete|command|attach`
(not `--dry-run`), `work-item` (alias `workitem`) `add|edit|update|delete`, and
`ytrack api` with `-X`/`--method` POST, PUT, PATCH or DELETE (`-XPOST`, `=`
forms) or a body (`-f`, `-F`, `--field`, `--input`) without a read method, past
global flags before the group (`--host`, `--debug`, `--no-color`). A call with `--help` or `-h` only prints help and passes when that word stands alone: no `--` before it, and the word before it is no option, a `--flag=value`, or a flag known to take no value (`--debug`, `--no-color`, `--paginate`, `--include`, `--dry-run`, `--silent`, `--yes`, `--meeting`); after any other option it may be that option's value, so the call is judged as the write it carries. `--dry-run` and `-X GET` clear a call under the same rule, and a write method anywhere makes `ytrack api` a write. An option Workit does not know is read both as taking the next word and as not; the stricter reading wins. It finds them through
`raw-git.ts` `commandLines` (chains, pipes, `cd`, env prefixes, wrappers,
`bash -c`, eval, heredoc-fed shells, substitutions, variables) plus
`workit check -- …`, `npx`/`bunx`/`pnpm dlx`, full-path spellings, an alias or
function defined in the same command and `$(which ytrack)`; the npx `workit`
form is normalised first (#816), so it gets the same answer. Scripts nested
deeper than four levels that name ytrack are denied as unanalysable. A write is
denied naming a `workit youtrack note|time|update|create` call only when that call
makes the same write (`issue comment --attach`, `issue attach`, `issue command
'<one quoted command>'` and an `api` POST to `/issues/<id>/comments` with one
`text` field or `/issues/<id>/attachments` with `-F <name>=@<file>` fields map
to `update` or `note`; plain ytrack writes chained right after the first one on
the same issue with `&&` or `;`, no `||`, pipe or other command between, become
one `update` call; a second comment, time or command, or another issue, keeps
the rule below): every option is one the mapping carries (`--body`/`-b`,
`--body-file`, `--duration` in whole minutes, `--text`, `--date`,
`--project`/`-p`, `--summary`/`-s`, `--description`, `--description-file`) and
every value is a literal with no `$` or backtick; a value starting with `-` is
written `--flag=value`. The call must also be a plain command: it must be the first command of the hook command, and of any script reached through `sh -c`, `eval`, `workit check --` or a package runner. Whatever precedes it, even a `cd` or a variable assignment, makes it a write no verb covers, because it can change the directory, the environment or the files the call reads. The call may sit behind only `command`, `exec`, `nohup`, `setsid`, `time`, `nice`, `ionice`, `stdbuf`, `chronic`, `unbuffer` or `timeout` (which change signals, session, priority, buffering, timing or output), with no assignment in front of it, no `env`, no `exec` option or `command -p`, no group, substitution, loop, function or `YTRACK_*` assignment, and no word the shell expands (`$`, a glob, a leading `~`). What follows it may only handle output or run other commands (`| jq …`, `> out 2>&1`, `&`, `; echo done`); a later ytrack write is never named. Any other write (`xargs`, `find -exec`, `parallel`, `watch`, `sudo`, a loop, an alias, a function, a variable, a shell fed on stdin) is judged as one no verb covers, so nothing can fill in or repeat a named call. Anything else (`--host`, `--tag`, `--meeting`, text on
stdin, a URL for the issue) is treated as a write no verb covers, naming the
part Workit cannot carry. Reads, `ytrack api` GET and `youtrack.writes: auto`
pass.

`youtrack.autoHosts` scopes `auto` (`autonomy.ts` `youTrackWritesPolicy`,
sealed in `grant-seal.ts` `sealProjection` next to `writes`; `lowersOnly`
reseals a non-terminal write only when the list shrinks or `writes` goes to
ask, and an absent key keeps an older seal's digest). Under it the gate lets a
write through only from a plain command whose `--host` words before a bare
`--` (`hostsOf`: every one counts, whatever precedes it, since after a flag
Workit does not know, `-i --host x`, it may be ytrack's own and ytrack takes
the last; at least one must stand alone, so `--body --host x` alone names no
host) are all literal and allowed, compared by `youTrackHostKey`
(youtrack-cli `hosts.Parse`: lower case, no scheme, default port, trailing `/`
or `/api`; credentials never match). A write that names no host, a non-literal
`--host`, or an allowed one in a command that is not plain (`xargs`, `find
-exec` and `parallel` append words the hook never sees) is denied on every
host with `Retry as: ytrack --host <first allowed> …`; a write to another host
gets the answer it gets under ask; a command that names `YTRACK_CONFIG_DIR`
(hosts.yml maps a host key
to the URL called) and an unanalysable one naming ytrack are denied. URLs and
`YTRACK_HOST` never name the target. The verbs ask unless `youTrackTarget`
(the workspace's `youtrack.baseUrl`, else youtrack.json's) is allowed, and
pass it as `YTRACK_HOST`; `ytrackWrite` and the PR backlink check
youtrack.json's host, the one `youTrackBackend()` reaches. Plain `auto`
without the key keeps any host; doctor's `youtrack_writes` row warns.

- **Claude Code:** N. The launcher sends a command to the runtime when its text, with quotes and backslashes removed (and again with backticks removed), has `ytrack` not followed by `[\w/-]` or by a `.` other than `.exe`/`.cmd`, in any position (`hooks/ytrack-word.ts`, the test the gate itself starts with): `cat docs/ytrack-notes.md` stays on the fast path, `grep -rn ytrack docs` loads the runtime and passes; a write no verb covers gets `permissionDecision: "ask"`.
- **Codex:** N. The hook entry uses the same test; a write
  no verb covers is denied, handing the command to the user's terminal (the
  hook cannot ask).
- **Cursor:** N. `beforeShellExecution` denies the same way.
- **Pi:** N. The `tool_call` hook blocks the same way (it drops an ask).
- **OpenCode:** N. `permission.evaluate` (`v2/permissions.ts`) denies the same
  way, after `execute.before` rewrote an npx workit call.
- **Under `youtrack.autoHosts`, every host:** N, one core gate. An allowed write
  passes with no answer (Claude Code, Codex, Cursor, Pi, OpenCode alike); a
  write with no host (or a wrapped or non-literal one) is denied on all five,
  never asked, with the `--host` retry; a write to another host is asked on
  Claude Code and denied on Codex, Cursor, Pi and OpenCode, as under ask.
  (L) Claude Code and Pi: the inline ask on a `workit youtrack` call
  (`approvals/inline.ts`) passes no host, so it reads the workspace's own
  `youtrack.baseUrl`; with none it asks although the verb would post unasked
  to youtrack.json's allowed host. (L) Claude Code and Codex: the hook entry's
  ytrack-word test sends only a command that names ytrack to the runtime, so a bare
  `export YTRACK_CONFIG_DIR=…` with no ytrack call in it is not judged; one in
  the same command as the ytrack call is.
- (L) A ytrack name the text does not spell as a word (`$a$b`, `xargs -IEXT ytrackEXT`, `$'\x79track'`, a glob, cmd `^`), a variable only the nested shell sees (`YT=ytrack bash -c '$YT …'`), an alias or function from an earlier call, `ssh`, `docker` or `su -c` running it elsewhere, and an interpreter or script file that runs it are not seen. (P) A help or read call whose `--help` or `-X GET` directly follows an option Workit does not know is asked: put it first.

A launcher pre-filter is the gate's own first test, copied byte for byte and compared by a test, and it may skip the runtime only on a property the gate itself passes on; it never lists the positions, wrappers or commands where a tool name counts, because a list of places to look misses every place it does not name.

`findYtrack` ignores `PATH` when `WORKIT_NO_YTRACK=1`,
which the test preload sets, so a test never spawns a developer's real ytrack:
tests use a stub `ytrack` on a `PATH` in an env they build.

The ytrack agent skill (youtrack-cli #16) ships inside ytrack, and ytrack
0.6.0 and newer installs, remembers and refreshes every copy itself
(`ytrack skill install|list|sync|uninstall`; default dirs `~/.agents/skills`
and `~/.claude/skills`). Workit never installs or refreshes it, and never
upgrades ytrack. The doctor's `ytrack_skill` row reads
`ytrack skill list --json` (`listYtrackSkill` in `core/ytrack-skill.ts`;
`{dir, path, version, state, managed}`): no copy names `ytrack skill install`,
a stale or missing home copy `ytrack skill sync`, a stale repository copy
`ytrack skill install --dir <dir>`, and a ytrack without `skill list`
`ytrack upgrade` (to 0.6.0 or newer).

An older Workit installed the skill into each host's root (`hostSkillsRoot`
in the CLI's `upgrade/skill-roots.ts`) and recorded the directories it
created in `<state dir>/ytrack-skill.json`. When `~/.agents/skills/ytrack`
holds the skill, `workit upgrade` (`retireYtrackSkillCopies` in
`upgrade/ytrack-skill.ts`) removes the recorded Codex, Cursor, OpenCode and Pi
copies through `removeYtrackSkill` and deletes the record; a failed removal
keeps it for the next run. A recorded copy whose real path is the shared
copy's, holds it or sits inside it (a symlink either way) is never removed,
and the shared copy is checked again before each removal. ytrack still lists
the removed copies as missing; while a current copy sits in `~/.agents/skills`
or `~/.claude/skills`, doctor passes with a note that `ytrack skill sync`
forgets them. `~/.claude/skills/ytrack` is one of ytrack's own
copies then, so upgrade forgets it and uninstall keeps it (`ytrackOwnsCopy`).
Uninstall removes any other recorded row only when its path is exactly that
host's `<root>/ytrack` and no component from the home down is a symlink
(`ytrackSkillPathRefusal`, checked when planning and again before deleting);
any other recorded path is reported and left untouched.

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

- First, whatever the host (`none` and `cli` included): an id the issued
  registry holds with a token hash needs that token (`unbound_session`). The
  registry decides, not the environment, so clearing the host variables
  proves nothing (#975).
- `none`: otherwise accepted; `--session X` and `WORKIT_SESSION_ID=X` are one rule.
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

The global `workit --session <id>` runs the same check before any verb, with
the verb's `--token` or `WORKIT_SESSION_TOKEN`; a read verb is not exempt (it
needs no `--session`). A `WORKIT_SESSION_ID` a ledger write acts as meets the
`--session` grammar (ASCII `[A-Za-z0-9_.:@/+-]`, 1-128), so a lookalike id is refused.

`workit git commit` runs the same check on its acting session and refuses an
issued id (`judge_session`). The gate (`ledger.ts` `sessionTrust`) re-checks
recorded rows: `unissued_session`, and `unbound_session` for a token-backed id
whose row lacks `sessionBound: true`, whatever host recorded it (`cli` rows too).

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
byte-equal copy in `claude-code/bin/`, `cursor/hooks/` and `codex/bin/` (the
MCP launcher), imported into the Codex hook bundle; a test holds the copies equal) in this order: (1) `WORKIT_NODE`;
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

Owned CLI (#648): host launchers run bundled code and spawn `workit` only for
session teardown (`hooks/teardown.ts`, the CLI located the same way), but the
agent's shell runs whichever `workit` is first on `PATH`, and a stale global
copy can sit ahead of the owned launcher. `core/cli-locate.ts`
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
| Issued-registry guard (#292): agent writes under `<state>/issued*` and `<state>/approvals/` (host-approval requests and grants) | N `PreToolUse` on edit tools and shell writes (also under `workit check -- bash -c`) | N permission `evaluate` (edits and shell) | N `PreToolUse` on `apply_patch` and shell; L: `write_stdin` and specialized shell paths are not interceptable | P `preToolUse` + `beforeShellExecution`; a write with no readable path is not matched | N `tool_call` (edits and bash) | 
| Heavy-command gate (#325, ruling mvid5onk) | N `PreToolUse` after every Workit gate: one simple heavy command (output shaping is not a chain: any redirects and one trailing `\| grep …` filter stay outside the wrapped command; a trailing `[2>&1] \| tail\|head …` is dropped, since the exit-pipe gate would deny it (#912): `bun test 2>&1 \| tail -50` becomes `workit check --heavy -- bun test`) gets `updatedInput` `workit check --heavy -- <cmd>` (it waits `--wait`, else `resources.wait`, 30 min by default) with no `permissionDecision` (claude 2.1.306 applies it, then its own permission flow), except under auto mode, where it is denied with `Retry as: workit check --heavy -- <cmd>` (#908); a real chain (`&&`, `;`, several heavy parts) is denied with the split, which names the first heavy segment to run; a command a deny/ask rule names, or one only a `workit` allow would cover (not under `bypassPermissions`), runs as typed, with no note (#429). Rules read: managed-settings.json, `$CLAUDE_CONFIG_DIR`/`~/.claude/settings.json`, project `.claude/settings.json` and `settings.local.json`. L: `--settings`, `--allowedTools`/`--disallowedTools`, SDK `canUseTool` and server-managed policy are unreadable | N `execute.before` runs the permission hook's gates on the original, then rewrites one simple heavy command to `workit check --heavy -- <cmd>` (before the shell-session correlation notes it); `permission.evaluate` denies an allowed chain with heavy parts (ask and deny stand). Rules read: global, project and `.opencode/` `opencode.json(c)` up to the git top, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`: the V2 `permissions` rules whose `action` pattern matches `shell` and every `agents.*.permissions` (#869), and the deprecated V1 `permission.bash`/`shell` and every `agent.*.permission` | X: `PreToolUse` supports `updatedInput` rewrites (learn.chatgpt.com/docs/hooks), unused here; it denies one heavy command (shaped as above) with the exact `workit check --heavy -- <cmd>` and a chain with the split. Rules read: `~/.codex/rules/*.rules` and project `.codex/rules/*.rules` (`prefix_rule`); a rule it cannot parse means pass through. `workit setup` allows `workit check <test|lint|typecheck|build|format|docs>` and `workit lock status|wait` here, on Cursor and in Claude Code (never `check --`) | L: `beforeShellExecution` answers only allow/deny/ask: denies with the exact rewrite or the split. Rules read: `~/.cursor/cli-config.json` and project `.cursor/cli.json` `Shell(x)`. L: the IDE allowlist/denylist is unreadable | N `tool_call` after the gates: mutates `event.input.command` for one simple heavy command, blocks a chain with the split (Pi has no permission rules to read) |
| Exit-pipe deny (#912, `hooks/exit-pipe.ts`): a Workit verb whose exit code is its answer (`ci wait`, `check`, `pr merge`, `release …`, `verify-delivery`) piped into `tail` or `head`, anywhere later in the pipeline or from a group, is denied with `Retry as: <the unpiped call>` (verb first, `--cwd <dir>` for a literal `cd <dir> &&` before it), never rewritten; `set -o pipefail` before it leaves it alone | N `PreToolUse` deny, auto mode or not (#908) | N permission `evaluate` (deny) | N `PreToolUse` deny | N `beforeShellExecution` deny | N `tool_call` blocks |
| Dev-server routing and RSS notice (#328; `core/heavy.ts` `serverCommand`, `hooks/heavy-gate.ts`, `hooks/server-gate.ts`): a raw dev server (`ng serve`, `vite`, `next dev`, `npm start`/`run dev`, `docker compose up` without `-d`; through `npx`, `pnpm exec`, `yarn workspace`, `make`, `nx`, `bundle exec`) is routed to `workit run --bg -- <cmd>` like a heavy command (it wins over the lease: `docker compose up --build`); a chain is denied with the split; a deny/ask rule naming it, or an allow covering `workit` but not the command, leaves it as typed (#429). `workit run --bg` is never an allowed verb (decider ruling A); `workit ps` and `workit stop` are. The gates (raw git, branch policy, the before-write gate) judge `workit run --bg -- <cmd>` as if `<cmd>` ran raw. A process past the memory ceiling leaves `<state>/procs/notices/<session>.json`; the owner session's next hook takes it (renamed, then read: said once) | N `PreToolUse` `updatedInput` with no `permissionDecision`, as for heavy commands (under auto mode a deny with `Retry as: workit run --bg -- <cmd>`, #908); the notice rides `additionalContext` on the next tool call (the launcher fast path loads the runtime while a notice file exists) | N `execute.before` rewrites the command; `permission.evaluate` denies an allowed chain; P: the notice rides the session's next shell result (X: the session context hook would carry it); L: a child session's processes are owned by `<lead>:<child>`, whose notice its shell result does not take | X: `PreToolUse` supports `updatedInput`, unused here: denies with the exact `workit run --bg -- <cmd>` (as for heavy) and a chain with the split; the notice rides `additionalContext` (the quiet path loads the runtime while a notice file exists) | L: `beforeShellExecution` denies with the exact call or the split; L: Cursor puts no session id in the shell, so a Cursor row is a terminal row and no notice names a Cursor session (one written under `WORKIT_SESSION_ID` rides `agent_message` on the next shell call) | N `tool_call` mutates `event.input.command`, blocks a chain with the split; the notice rides `before_agent_start` on the next user turn or the next `tool_result`, whichever comes first (a supervised worker's as `<lead>:<worker>`) |
| Background process registry (#328): `workit run --bg`, `ps`, `stop` and `gc --procs` are CLI verbs, so every host gets them through its shell. The owner proof is the host pid from the CLI's process ancestry plus its start time. On Windows a stop goes through the supervisor that holds the child: `workit stop` leaves a stop request it polls for, and it ends the child's tree with `taskkill /T`, then `/T /F` after 10 s. L (Windows, every host): there is no host pid or start time, so rows are listed and never auto-stopped, and with the supervisor gone the stop only reports (no taskkill). RSS notices are written for every host; each host's hook surfaces them (the dev-server routing row). L (every host): a server an MCP tool starts never passes a shell hook, so it is never routed or registered | N: the shell | N: the shell; the owner pid is the OpenCode server process, so its rows outlive a session until the server exits | N: the shell | L: Cursor puts no session id in its shell, so a Cursor row without `WORKIT_HOST` is a terminal row, stopped only by `workit stop <id>` | N: the shell |
| Automation browsers (#328): `workit stop --session\|--within\|--orphans` and `gc --procs` scan the process table in the CLI, so every host gets it. Owner proof: the browser's own environment (`WORKIT_SESSION_ID` or the host's session variable; Linux only) or a live session's host pid and start time among its ancestors. A browser with no proof is listed as `pid:<pid>`, never stopped. L: Windows lists automation browsers and never stops them. L: macOS cannot read the environment, so a browser whose launcher detached is listed, not stopped | N: the CLI | N: the CLI | N: the CLI | N: the CLI | N: the CLI |
| Session teardown (#328, `hooks/teardown.ts`): when a host session really ends, its registered processes (its workers' too) stop through a detached `workit stop --session <id> --reason session-end`; at a session start, orphans of dead sessions are reaped through a detached `workit stop --orphans --reason session-start`, at most once per 10 minutes per user (`<state>/procs/reap-at-start.stamp`; an exclusive `.claim` file lets one of two simultaneous starts reap). Only a reason on the host's allowlist ends a session (Claude Code `logout`, `prompt_input_exit`, `other`; Cursor `completed`, `aborted`, `error`, `window_close`, `user_close`; Pi `quit`; OpenCode a deleted session), so a reason a host adds later stops nothing. Both run the owned CLI (`core/cli-locate.ts`), never `workit gc` (decider ruling 8), open no SQLite in the hook, and fail open: a CLI that cannot start leaves no stamp. The detached CLI runs in `<state>/procs`, never the session's checkout, so on Windows it does not keep the checkout busy (#904). The CLI leaves rows held by a keep decision, workspace `cleanup: keep` or a terminal start running and says why in `<state>/procs/teardown.log`. L: on Windows the teardown log records each stop it starts, not the CLI's output. A worker's end (a `<lead>:<child>` id, a subagent, a supervised Pi worker) stops nothing: `--session` on a worker id would select its lead's rows, so the lead's end or the reap stops them | N `SessionEnd` (cannot block; registered with `timeout: 10`, above the 8 s hook deadline; claude 2.1.327 gives a SessionEnd hook max(1.5 s, its timeout)): reasons `logout`, `prompt_input_exit` and `other` stop; on `clear` and `resume` the session goes on and its rows stay with the live host pid; the reap on `SessionStart` | P: no exit or start event: `event("session.deleted")` stops a deleted session's processes, and the reap runs on the first lifecycle event the plugin sees after OpenCode starts; the owner pid is the OpenCode server, so a session that ends without deletion leaves its processes until the server exits and the next reap (any host's start) | L: Codex sends no worker id on SessionEnd; its processes are stopped by the next session-start reap after the host exits (codex-cli 0.169.0-alpha.11.1 runs `SessionEnd` hooks, but the payload has no agent id and subagents carry the lead's `session_id`, so Workit does not register it); the reap on `SessionStart` | N `sessionEnd` (cursor-agent 2026.09.26: `conversation_id`, `reason`, `final_status`; its output is not read); the reap on `sessionStart`; L: a Cursor row without `WORKIT_HOST` is a terminal row, which the session end leaves running | N `session_shutdown` reason `quit` (`new`, `resume`, `fork` and `reload` go on in the same process); the reap on `session_start` |
| Heavy-check pressure gate (#326): enforced in the CLI lease, so every host gets it through `workit check`. P: Linux reads PSI (`/proc/pressure/{memory,cpu}` some avg10) and falls back to 1-minute load sampling without PSI; macOS samples the load average and Windows samples CPU busy time, so neither has a memory-pressure source. It fails open everywhere a source is unreadable; `workit doctor` names the source on `pressure_gate`, and `resources.pressure: false` turns it off | N: `workit check` | N: `workit check` | N: `workit check` | N: `workit check` | N: `workit check` |
| Claude Code host-isolated worktrees (`.claude/worktrees/agent-*`) | N: the host owns the directory. Workit never removes it in merge cleanup or `gc --worktrees`; it is kept as 'a host-owned worktree (.claude/worktrees); the host removes it'. `workit gc --branches` deletes its `worktree-agent-*` branch only once nothing has it checked out and its work is proven on the trunk | N: no host-owned worktree dirs; the sweep is CLI-side | N: no host-owned worktree dirs; the sweep is CLI-side | N: no host-owned worktree dirs; the sweep is CLI-side | N: no host-owned worktree dirs; the sweep is CLI-side |
| Hook deadline under load (#309); each host's deadline sits below its own timeout (`HOST_DEADLINES`; `WORKIT_HOOK_DEADLINE_MS` overrides all) | N: `hooks.json` timeouts 15 s (prompt, tool, subagent) and 20 s (`SessionStart`, `Stop`); deadline 8 s, 16 s for `SessionStart` and `Stop`; past it the hook answers `additionalContext` naming the skip | L: in-process plugin, no host timeout to beat (the server awaits the hook); no deadline applied | N: `Stop` `timeout: 20`, deadline 16 s; unset hooks keep Codex's default timeout (600 s per the Codex hooks docs, not read from the binary), deadline 45 s | N: no `timeout` set, so Cursor's 60 s default holds (`DEFAULT_HOOK_TIMEOUT_SECONDS`, cursor-agent 2026.09.26); deadline 45 s on every event, `subagentStart` included (`agent_message` on `beforeShellExecution`) | L: in-process extension, no host timeout; no deadline applied |
| `cd <dir> && workit …` normalised to `workit <verb> --cwd <dir> …` (#388, #297, `hooks/cwd-normalize.ts`) | N `PreToolUse` `updatedInput`, no `permissionDecision`, so `Bash(workit <verb> *)` matches; under auto mode the `cd` compound is denied with `Retry as: <the --cwd call>` and the verb-first reorder is skipped (the call runs as typed, #908); the verb goes first for an allowed verb (else `workit --cwd <dir> …`), and a plain `workit [--json] --cwd <literal dir> <allowed verb> …` is reordered the same way (`--session` before the verb is left alone); only `cd <literal dir> && workit … [2>&1] [\| tail\|head\|grep …]`, anything else (`cd $VAR`, `cd -`, `;`, `\|\|`, another segment) runs as typed; a heavy-gate rewrite wins (a workit command is never heavy itself) | N: the shell hook already strips the `cd` | X: `PreToolUse` supports `updatedInput` (learn.chatgpt.com/docs/hooks), unused here: nothing is denied or rewritten, the contract text (`workit <verb> --cwd <dir>`) carries it | L: `beforeShellExecution` cannot rewrite: contract text only | N: no permission layer, nothing to normalise |
| `npx -y @workit-dev/cli …` run as `workit …` when `workit` is on PATH (#816, `npxWorkit` in `hooks/cwd-normalize.ts`) | N `PreToolUse` `updatedInput`: rewritten to the `workit …` call (then verb-first and `--cwd`; under auto mode denied with `Retry as: <that call>`, #908), judged by every gate as that call; a `workit approve` through npx is denied naming the plain call, the one the host records | N: the shell hook rewrites the command | L: the hook cannot rewrite here: denied naming the exact `workit …` call | L: `beforeShellExecution` cannot rewrite: denied naming the exact `workit …` call | N: `tool_call` rewrites the command; `workit approve` through npx is denied naming the plain call |
| No Bash rewrite under auto mode (#908, `hooks/handle.ts` shell.pre): Claude Code's auto mode refuses a call whose input a `PreToolUse` hook changed after its classifier reviewed it, so each rewrite (the `cd` compound, the heavy lease, the dev-server route, `npx @workit-dev/cli`) is a two-line deny there: `workit <gate>: <what>.` then `Retry as: <the rewritten call>` | N: `permission_mode: "auto"` in the payload turns each rewrite into that deny; any other mode rewrites as before | N: the plugin rewrites in process before OpenCode's permission check; no classifier reviews the original, nothing to refuse | N: the hook never rewrites (it already denies with the exact call) | N: `beforeShellExecution` cannot rewrite (it already denies with the exact call) | N: `tool_call` mutates the input before Pi runs it; no classifier, nothing to refuse |
| Host permission setup (#297, `admin/host-permissions.ts`; verbs in `hooks/delivery-verbs.ts`). L on every host: an allowed `workit git …` runs the repo's git hooks and config (husky, `core.hooksPath`, `core.sshCommand`) unprompted | N: `workit setup` merges `Bash(workit <verb> *)` allows, `ask` rules for bypass flags (second layer), `autoMode.environment`/`allow` lines and `env.CLAUDE_CODE_SHELL` into the user `settings.json` (never managed settings); the user-only calls (`WORKIT_USER_ONLY`: `release notes approve`, `grant set\|raise`, #615; `ledger void`, #759; `approve`; `setup`, `uninstall`, `install` and `workspace seal` as whole verbs, `--preview` and `--dry-run` included) get `ask` rules anchored at the verb (ask beats allow, also in auto mode; a `Bash(workit * …)` glob reads quoted text too, so it asked on a call that only mentioned the words, and a refresh drops the ones Workit wrote, #759) and the auto-mode text names them as not covered; an upgrade replaces the old text; the `PreToolUse` hook also answers `ask` for a user-only call with global options before the verb or behind a wrapper (`env -u CLAUDECODE`, `AI_AGENT=1`, `command`, `cd x &&`; `userOnlyWorkitCall`), which the launcher sends to the runtime by the gate's own first test (`mayRunUserOnly`: the word `workit` and a user-only first word anywhere, backslash-newlines joined and quotes and backslashes removed, or `workit` with a `$'…'`/`$"…"` spelling), and answers `permissionDecision: "ask"` for a workit call whose parsed words carry a literal bypass flag before `--` (`workitBypassFlag`; a word with an expansion is not read, L: `${F:---unverified}` is not asked, the merge grant and `--reason` gate it), and puts the verb before `--cwd`/`--json` so the rules match. L: plugins cannot ship permissions; a hook `allow` is still classified in auto mode. Auto mode (W2.12): the `Bash(workit <verb> *)` allows in `permissions.allow` cover the verbs in `WORKIT_ALLOWED_VERBS` (`git`, `pr`, `ci`, `stack`, `release`, `task`, `ledger`, `evidence`, `finding`, `decision`, `worker`, `verify-delivery`, `policy`, `doctor`, `help`, `ps`, `stop`) plus `workit check <name>` and `workit lock status\|wait`, and the one `autoMode.allow` line (V6: C17's V4 with the #882 scopes, `issue close` included) names the grant-gated delivery verbs (`workit git push` of a branch the session created or the workspace allows, `--force-with-lease` only on the session's own branch; `workit pr create`; `workit pr edit\|ready` on the session's own PR; `workit pr merge\|reply\|resolve`; `workit release`; `workit issue create\|comment\|close` with no `--repo` or a `--repo` under the workspace's own forge owners or listed in its `externalRepos`) as authorized by the user's grants, naming only workit calls (never raw `git` or `gh`; the CLI enforces each grant and, since #882, the own-PR and issue-owner scopes: `pr edit\|ready` refuses another author's PR without `--others-pr --reason`, and `issueTarget` refuses a write to a `--repo` outside the workspace's owners that `externalRepos` does not list; L: the branch scope is guidance for the classifier, not a CLI check; the text names `--others-pr` and `workit workspace set` of remotes or externalRepos as not covered), and the `autoMode.environment` line names `workit` as the user's delivery CLI; neither covers the user-only calls or a bypass flag. Setup and upgrade replace an earlier exact Workit line (`PRIOR_ENTRIES`) in the consent diff; a line that starts `Workit-gated delivery:` but matches no shipped text is the user's edit: kept, the current line not added, one setup note. An upgrade refresh does not add the current line when the user deleted the earlier one Workit offered (`removedAutoAllow`); `workit setup` does. L: `workit issue` is not in `WORKIT_ALLOWED_VERBS`, so outside auto mode it still prompts. L on OpenCode, Codex, Cursor and Pi: no auto-mode classifier to brief, so their allow rules (or, on Pi, the CLI's own checks) alone decide the granted verbs. A hook that rewrites a call (`updatedInput`) is classified again, and auto mode refuses it ("a hook changed this call's input"), so under auto mode no Workit hook rewrites a Bash or Agent call: it denies with the exact call to send (#908) | N: no allow rule is written (the native deny patterns are the next row); `permission.evaluate` turns an `ask` into `allow` when every resource is only allowed Workit calls (never a user-only call, #615) with no expansion before `--` (the one place a Workit hook answers allow; config `deny` wins first), and turns a config `allow` of a user-only call (`userOnlyWorkitCall`, any wrapper or global option) into an `ask` naming it (U: unverified that a live OpenCode honors a plugin's allow-to-ask downgrade) | N: Workit-owned `rules/workit.rules`, flat `prefix_rule` per verb, `grant` → `prompt`, plus a `prompt` rule for each user-only call (#615). the `PreToolUse` hook denies a user-only call whatever global options or wrappers precede the verb (`userOnlyWorkitCall`), and the hook entry loads the runtime for any text the gate's first test passes (`mayRunUserOnly`). L: a prefix rule cannot see a later bypass flag or a `--cwd` before the verb; it matches argv words from the start, so a user-only call named only in an argument's text never prompts | N: `Shell(workit <verb>)` in `~/.cursor/cli-config.json` (prefix match, cursor-agent 2026.09.26 `matchesShell`). The hooks answer `permission` only for what Workit decides (#635): `deny`, `ask`, and `allow` on a `subagentStart` whose worker Workit assigned; a pass-through, a nudge (`agent_message` alone), a degraded payload and a `subagentStart` with no active task omit it, which cursor-agent 2026.09.26 treats as no answer (it acts only on `deny`/`ask`), so the user's allowlist and auto-run settings decide; L: the IDE's handling of an omitted answer is unverified. L: same prefix limits; `--session` before the verb does not match; the IDE `permissions.json` replaces the whole list, so it is left manual; the user-only calls are `permissions.deny` entries (#615) and the `beforeShellExecution` hook denies them with any global option placed before the verb (`userOnlyWorkitCall`) | L: no permission layer, nothing to write; the `tool_call` hook denies the user-only calls (#615) with any global option placed before the verb (`userOnlyWorkitCall`), then the CLI's TTY and agent-marker check stands; L: a command the shell tokenizer cannot analyze is not read |
| Native deny rules for the guarded paths (#820, `admin/host-permissions.ts` `nativeDenyEntries`; doctor `native_deny`): `<state>/issued*`, `<state>/approvals/`, the account config's `workspaces.json` and `workspaces.json.seal`, from the setup's env (each dir as written and through its links); they hold when the hook runtime fails to load. `workit setup`/`upgrade` write them in the permission block after the same consent, a refresh drops the ones the ownership record says Workit wrote for a path that moved, `workit uninstall` removes exactly them | N: `permissions.deny` `Edit(//<abs>/issued*)`, `…/issued*/**`, `…/approvals`, `…/approvals/**`, `…/workspaces.json`, `…/workspaces.json.seal` in the user `settings.json` (claude 2.1.323: `//` starts an absolute path, the rule content is gitignore-style; `Write`, `Edit` and `NotebookEdit` share one `edit` permission check, so an `Edit` rule covers all three; with `sandbox.enabled` the `Edit(...)` deny paths join `sandbox.filesystem.denyWrite`, so sandboxed `Bash` and the interpreters it runs are denied too); doctor reports `sandbox on\|off` from the user settings. A dir's `*`, `?`, `[`, `]` are backslash-escaped and each parenthesis is written `[(]`/`[)]`, the spelling claude 2.1.323's rule check suggests ("Ambiguous `\(` or `\)` beside an unescaped parenthesis"). U: the `//C:/…` form on Windows | N: V2 `permissions` rules `{"action": "edit", "resource": <abs>, "effect": "deny"}` appended to the global `opencode.json` (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`; opencode 2.2.7 matches an `edit` resource outside the project as its absolute `/` path, `*` crosses `/`; opencode 2.3.0, measured with `opencode debug agents` on a scratch home (#869), resolves each agent's rules as one ordered list: the built-in defaults, then a deprecated V1 `permission` block translated (`bash` → `shell`), then the global `permissions`, then `agents.<id>.permissions`, and the last match wins, so Workit's rules go after the user's and beat a V1 `permission.edit` allow). The `permission.edit` patterns a Workit before #869 wrote (the ownership record names them) move to `permissions` on setup or upgrade, in one reported line; a user's V1 entry stays, an empty V1 container Workit created goes, and uninstall still removes the V1 ones. Doctor counts rules in either shape; ones only in `permission.edit` are info with the setup command. Setup leaves the file untouched (and says so) when `permissions` is not a list or only an `opencode.jsonc` exists, and doctor names the hand edit in `permissions` instead of the setup command. Paths are written as is: OpenCode escapes every regex character but `*` and `?` (`i2`), so `(`, `)`, `[`, `]` stay literal. L: a `*` or `?` in a dir name cannot be escaped, so it widens the rule (it still covers the path); no OS sandbox; the `bash` tool is not covered; a project config's later `edit` rule can override (last match wins) | L: no path deny that holds across the user's permission choice (codex-cli 0.167.0-alpha.4.1; two attempts). Rules files have only `prefix_rule`, `network_rule` and `host_executable`: argv-prefix matches, no path rule, and a matching `allow` runs the command outside the sandbox. `requirements.toml` is read only from `/etc/codex`, MDM or the enterprise layer (one in `CODEX_HOME` is ignored) and its only filesystem field is `permissions.filesystem.deny_read`. `sandbox_workspace_write.writable_roots` is an allowlist. A `[permissions.<name>]` profile can mark a path `read` under a writable root, but only as the profile `default_permissions` selects: an added profile nobody selects does nothing, and with neither `default_permissions` nor `sandbox_mode` set it stops Codex loading (``config defines `[permissions]` profiles but does not set `default_permissions` ``); a profile cannot extend `:danger-full-access`, a glob (`issued*`) takes `deny` only, and a sandbox refusal can still be approved by the user or bypassed by an allow rule. Workit writes no profile and does not switch the user's; the `PreToolUse` hook stays the guard. Doctor reports `sandbox_mode` and warns when it is `danger-full-access` or a writable root holds a guarded path. U: bwrap enforcement of a `read` entry was not exercised (the test host blocks unprivileged user namespaces).| N: `permissions.deny` `Write(<abs>/issued*)`, `…/approvals`, `…/approvals/*`, `…/workspaces.json`, `…/workspaces.json.seal` in `~/.cursor/cli-config.json` (cursor-agent 2026.09.26 `shouldBlockWrite` checks `isPathExplicitlyDenied("Write", <realpath>)` before any allow; `*` matches any text); doctor reports `sandbox.mode`. Paths are written as is: cursor-agent escapes every regex character but `*` (`ct`), so `(`, `)`, `[`, `]`, `?` stay literal. L: a `*` in a dir name cannot be escaped, so it widens the rule (it still covers the path); shell writes are not covered by `Write(...)`; the IDE `permissions.json` stays manual | L: no permission layer, nothing to write |
| `workit feedback` upstream report (#777, `verbs/feedback.ts`; contract line `FEEDBACK_LINE` in `core/methods.ts`; `feedback` in workspaces.json; spellings in `askedWorkitCall`, `hooks/delivery-verbs.ts`) | N: contract line via `SessionStart`, hidden under `feedback: "off"`; `Bash(workit feedback*)` ask, and `PreToolUse` asks on every spelling (an env prefix, a global option such as `--session=<id>` before the verb, `npx`/`bunx @workit-dev/cli`, a shell's `-c` script behind `env`/`sudo`/`timeout`/`nohup`/`command` or not, `eval`, or a substitution) | N: line in the system context for the session's directory, hidden under `off`; V2 `permissions` shell ask rules (`workit feedback*`, `workit --cwd * feedback*`, `workit --json feedback*`) after the user's rules; not an allowed verb, so the plugin never allows it | N: line via `SessionStart`, hidden under `off`; `prompt` rule `["workit", "feedback"]`; `PreToolUse` denies a spelling the rule cannot see and names the plain one | N: line via `sessionStart`, hidden under `off`; L: no ask rule, so the verb stays out of the `Shell(...)` allows and Cursor's own approval asks | N: line in the contract for `ctx.cwd`, hidden under `off`; L: no permission layer, so nothing asks before `--post` |
| Session id without an env prefix | N: none needed | N: shell env set by the host | N: `CODEX_THREAD_ID` | N: Cursor puts no session id in the shell, so the addendum says `workit --session <id> …` (global flag, only before the command; `WORKIT_SESSION_ID` still works and the flag wins; on a host that checks the session the flag meets `sessionClaimRefusal` like the env var). | N: `PI_SESSION_ID` |
| Raw commit recording | N `PostToolUse` | N `execute.after` | N `PostToolUse` | P: settled on the next shell command; X: `afterShellExecution`/`postToolUse` | N `tool_result` |
| Branch-scoped worker assignment gate (#316) | L: no launch gate; a subagent is not tied to a worker assignment | N `execute.before` binds a native launch to the current branch's task; one unlaunched worker left on another task is rebound to it (assigned there, cancelled with a reason naming both tasks); anything ambiguous is denied with a branch-scoped hint | L: no launch gate | L: no launch gate | L: workers are supervised by workit, no native launch gate |
| Launch-to-assignment binding and concurrent launches (#640) | L: no launch gate; a subagent is not tied to a worker assignment | N: several `subagent` calls in one turn run concurrently (OpenCode 2.2.5 runs them in parallel; `test/opencode-v2` "concurrent subagent calls complete in one turn"). `execute.before` reserves, per call id, the free assigned worker the prompt is for (`v2/launch-match.ts`): a worker id in the prompt (`WORKER: <id>`), else the assignment whose objective or scope paths the prompt carries (the same brief assigned twice: the newer one), else the one its role (`ROLE:` line or agent type) picks; a launch that fits several equally is refused before anything is recorded, naming each worker, and a prompt naming a worker another call is launching is refused. The child binds by its call's result, or at `session.created` by its title (OpenCode 2.2.5 titles the child with the call's `description`; a duplicate description among open launches gets ` [<worker id>]` appended) | L: no launch gate | L: no launch gate | L: workers are supervised by workit, no native launch gate |
| Verifier/reviewer own session | N `SubagentStart` (`workit:verifier`, `workit:reviewer`) | N: child shell gets `WORKIT_SESSION_ID=<lead>:<child>` (`shell.hook("create.before")`), and a child without a worker records evidence and findings under it; native parent binding; X: `agent.transform` definitions | N `SubagentStart` (`workit-verifier`, `workit-reviewer` agent types); P: shipped read-only (`sandbox_mode`) agents the MCP launcher copies into `$CODEX_HOME/agents/` (L: codex-cli 0.160.1 plugins cannot register agents) | P: role markers; L: `subagentStart` cannot add context | N: supervised worker shell gets `WORKIT_SESSION_ID=<lead>:<worker session>`; L: no host subagents |
| Real session for verdicts (`forged_session` refusal) | P: subagent `<lead>:<agent id>` accepted only when SubagentStart issued it, with the token it handed that subagent (each id issued once; binding sticky per lead); L: the token sits in the subagent transcript on disk; L: anyone who can run the hook bundle can mint a new id and token; L: the lead's own id is the declared `WORKIT_SESSION_ID` (no host-set id in the shell; `CLAUDE_CODE_SESSION_ID` unused), so an inline colon-less id such as `<lead>-v<n>` is still declared; L: the issued-id record is per-user state files a deliberate write can forge | N `OPENCODE_SESSION_ID` (set by the shell tool); children `<lead>:<child>`; `WORKIT_HOST=opencode` without it is refused; L: removing both reads as a plain terminal | P `CODEX_THREAD_ID` for the thread; subagent `<lead>:<agent id>` only when SubagentStart issued it, with its token (L: unverified whether a subagent's shell gets its own thread id; `--as verifier` otherwise); `WORKIT_HOST=codex_*` without it is refused; L: the issued-id record is forgeable by a deliberate write | L: no session id in the agent shell and no `WORKIT_HOST`: declared, not checked | N `PI_SESSION_ID` (bash tool); workers `<lead>:<worker session>`; `WORKIT_HOST=pi` without it is refused |
| Exact verdict line at judge start (#271 S2a, `verdictCommand`) | N `SubagentStart` for `workit:verifier`/`workit:reviewer` (L: Claude Code subagents share the lead's environment, so no per-agent env var or file can carry the token; it stays on the line, #427): `workit ledger verdict <verified\|failed\|blocked> --kind <live\|unit> --branch <b> --session <lead>:<agent id> --token=<t> --how "…"` (`--kind review` for a reviewer); an id SubagentStart already issued gets no command, only "spawn a fresh verifier"; `--branch` is the checkout's branch, or `<branch>` on a protected branch or detached HEAD (ruling mvij5l86); a sentence after it says to add `--cwd <candidate worktree>` when the shell is elsewhere (the verifier and reviewer agents and the brief's verifier SPAWN line carry it inline); implementers get none | N `<workit-verdict-line>` in the child's `session.hook("context")` system parts, for any child but an implementer worker (no Workit agent types name a judge, ruling mvij5le6); no `--session`/`--token`: the child shell already acts as `<lead>:<child>` | N `SubagentStart` for `workit-verifier`/`workit-reviewer`: the same line with no `--session` and no `--token` (the child's `CODEX_THREAD_ID` is its own id; nothing is issued, #427), and the same `--cwd` sentence | L: `subagentStart` cannot add context, and judges are marked in the task text, not by agent type (ruling mvij5lpm) | L: supervised workers have no shell tool (`--tools` allowlist without `bash`), so they cannot run `workit ledger verdict`; reviewers record evidence and findings (ruling mvij5ljz) |
| Bounded task brief for children (`task inspect`, #342) | N: CLI `task inspect` prints the brief (no native task tool; subagents call the CLI) | N: a child with no worker may call `workit_task` `inspect` (`v2/child-identity.ts`) and gets the brief; its other task actions stay denied | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: MCP `workit_task` `inspect` returns the brief to an unattested caller | N: a worker's `workit_task` `inspect` returns the brief; L: Pi has no host subagents beyond workers |
| Decider call (#335: one fix round and one recheck, then a decider; `ledger decision --by decider`; D1: a `decider` agent on every host but Pi) | N: the `workit:decider` plugin agent (`model: fable`, `effort: high`, no Write/Edit); second decider on another model via `model` on the Agent call | N: the plugin registers `workit-decider` (edit denied) on its `models.roles.decider` model; a second decider names another `model` on the `subagent` call | P: the `workit-decider` agent TOML (read-only sandbox, `model` when configured); L: one decider, a model in the file beats the spawn's | N: the `workit-decider` plugin agent (`permissionMode: readonly`); second decider on another model via the optional `model` argument of the Task tool (cursor-agent 2026.09.26 bundle) | P: skills plus the CLI; L: one decider, the host picks no per-spawn model |
| Review lanes and `verification: proportional` (#333: lane from the diff in core, read by `pr merge`, `stack land`, the Stop hook and `policy assess`) | N: core gates and the Stop hook; a focused-lane verifier on the cheap tier via `model: sonnet` on the Agent call | N: core gates and the Stop hook; the registered `workit-verifier` agent runs on the `verifier` role model, and a focused-lane verifier names a cheaper `model` on the `subagent` call (a named model wins) | N: core gates and the Stop hook; L: the host picks no per-spawn model, so focused and full verifiers share one | N: core gates and the stop hook; cheaper verifier via the optional `model` argument of the Task tool | N: core gates and the Stop hook; L: the host picks no per-spawn model |
| Implementer spawn gate (#432, `hooks/spawn-gate.ts`) | N `PreToolUse` on Agent/Task: `isolation` is dropped through `updatedInput` on every agent type (#654), except under auto mode, which refuses a rewritten spawn: there the spawn is denied once with the same args without it (retro 2026-11-07 R1), and a `workit:implementer` prompt must name a Workit-made worktree: a made `WORKTREE:` line (a brief or the pointer `fanout worktree create` prints), the worktree's path (its git admin dir holds the fanout token), or a brief file holding a `WORKTREE:` line. Otherwise the deny is two lines: what is missing, then `Retry as: workit fanout worktree create <slice>` (the slice word from the prompt's `WORKER:`, `brief` or `create`, else the description) and "spawn again with the WORKTREE line it prints as the prompt's first line". The implementer is still bound to the first worktree it writes in. The launcher fast path answers a briefed implementer or another type that names `model` only when `workspaces.json` configures no role models, and loads the runtime for any spawn with `isolation` and an implementer spawn with no `WORKTREE:` line | L: no hook runs before a child session starts; the lead's brief is the only gate | L: no pre-spawn hook and no host worktree isolation to strip; the copied `workit-implementer` agent and the brief carry the rule | L: implementer subagents are denied at `subagentStart`, which sees no brief | L: no host subagents and no host isolation; the lead's brief is the gate |
| Standing-order deltas and the stop line to running workers (#320, `hooks/standing.ts`; memory/CPU pressure holds new heavy checks in the CLI lease (#326) instead of stopping workers) | N `PreToolUse` `additionalContext`, once per revision; the subagent is `agent_id` under the lead's `session_id` with a Workit `agent_type` (`workit:implementer`, `workit:verifier`, `workit:reviewer`; another type, such as an Explore or inventory agent, gets orders only on a slice branch, W2.27), its baseline taken at `SubagentStart`; X: only the matchers workit registers (Bash, PowerShell, edits, Skill), so a worker that only reads sees it on its next one; the launcher fast path loads the runtime only when `standing/rev` differs from the agent's seen file | N `<workit-standing>` in the child's `session.hook("context")` system parts on every model call while the change stands (the system context is rebuilt per call, so it never stacks); the child is its `parentID`, its baseline its first call; L: the context hook names no agent type, so every child of the lead counts as a worker (W2.27) | P `PreToolUse` `additionalContext` (matcher `*`), baseline at `SubagentStart`; L: unverified that a subagent's `PreToolUse` carries the lead's `session_id` with its `agent_id`; a thread on a slice branch is matched by branch | P `agent_message` on `beforeShellExecution` (unverified that the model reads it) and `additional_context` on `preToolUse`; L: a subagent's tool events carry no parent conversation, so only a session on a slice branch is a worker (implementer subagents are denied anyway) | P: the worker's next `tool_result` (L: `tool_call` cannot add context); a supervised worker acts as `<lead>:<worker session>` and is seeded at launch |
| Worker tool-call budget (retro P9, `hooks/budget-signal.ts`; TIMEBOX `N tool calls`, default 120, 180 for a hard-tier slice) | N: a lead's Agent/Task spawn that passes the spawn gate queues N or an explicit none (a denied spawn queues nothing), `SubagentStart` takes the head entry of its `subagent_type` and binds it to `agent_id`, `SubagentStop` deletes the agent's budget files (leftovers age out after 7 days), no warning for a worker that stops with background commands still running (W2.35, L: claude 2.1.318 `SubagentStop` `background_tasks` lists the in-flight work of the whole session with no owning agent, so a worker's own tasks cannot be told from the lead's; the agent prompts carry the rule instead), the launcher appends one byte per `PreToolUse` without loading the runtime (Read, Grep and Glob gain a matcher for this) and only the Nth call loads it: one `additionalContext` line at N, again at 2N; never a deny. L: SubagentStart does not carry the prompt, so the spawns of one `subagent_type` are matched to agents in the order they start; a tool no matcher names is not counted | P: the lead's `subagent` call queues N, the child binds it on its first `execute.before` and each call counts; the line stands in the child's `<workit-standing>` system part from N on (the system context is rebuilt per call, so it is not a one-time line) | P `PreToolUse` `additionalContext`: a lead's non-shell, non-edit tool input that names an agent type or carries a `TIMEBOX:` line queues N or none, `SubagentStart` binds it, `SubagentStop` deletes it; L: unverified which Codex spawn tool field carries the prompt | X: not wired | P: a supervised worker binds N from its launch prompt or objective; the line rides the Nth `tool_result` (L: `tool_call` cannot add context); a Pi session Workit did not launch is not budgeted |
| Implementer worktree guidance (#310) | N `SubagentStart`: the lead's `workit fanout worktree create` worktree, `workit --cwd <worktree> git\|check …` one verb per call; the agent has no `isolation` (Claude Code's refused every unverifiable command and every wrapped git, and cannot be turned off). An implementer still spawned with `isolation: "worktree"` (cwd `.claude/worktrees/agent-<id>`) gets the plain-git text instead | X: the `worktree` domain is unused | P `SubagentStart` text and the shipped `workit-implementer` agent; L: no native worktree isolation, the lead makes one | P: implementers denied at `subagentStart` | L: no host subagents |
| Implementer worktree confinement (#310, `hooks/worktree-confine.ts`) | N `PreToolUse` (edits, shell writes, mutating raw git, `workit --cwd <dir> git commit\|branch`) for `agent_type` `workit:implementer`: the first change inside a worktree whose admin dir holds the fanout token binds the agent (`<state dir>/worktree-bind/`, keyed by session and agent, so it holds whatever the hook cwd; a `worktree.bound` row); after that a change outside it is denied naming it, before that one outside every Workit worktree. Always denied: the lead's worktree, ref, config and fan-out changes (`git worktree` other than `list`, `update-ref`, `symbolic-ref` writes, `branch -d/-D/-f/-m/-M/-c/-C`, `tag -d/-f`, delete/`--mirror`/`--prune` pushes, a force push with an explicit refspec (`git push --force-with-lease` alone stays), any push refspec with `:` or a leading `+`, `replace`, `notes` writes, `filter-branch`, `gc`, `prune`, `repack`, `reflog` other than `show`, `submodule` other than `status`, `sparse-checkout`, `config` and `remote` writes, `stash drop/clear`, `workit fanout plan\|worktree`, also behind workit's global options such as `--json`, `--cwd`, `--session`). Writers the edit analysis cannot read (`sh\|bash -c` scripts, with shell options before `-c`, are read like `workit check -- bash -c`, and `cmd /c|/k` and `pwsh|powershell -Command` scripts statement by statement, and so is a heredoc a shell reads on stdin (`bash <<'EOF'`, `sh -s`, #880); `busybox` is a prefix; `env`'s `NAME=value` words (any name, `env 'A b=1'`), its options (`-u`, `-C` with their value) and `-S '<line>'` lead to the command, as does a `NAME+=value` prefix, and so do transparent wrappers past their options and operand (`timeout`, `nice`, `ionice`, `setsid`, `stdbuf`, `nohup`, `time`, `chrt`, `taskset`, `npx`, `bunx`), for judges too, while opaque ones (`flock`, `watch`, `ssh`, `parallel`, `script`, `su`, `runuser`, `strace`) count as a writer in their directory, and so does code Workit cannot read as text (#880): a `pwsh\|powershell -File` script (and `pwsh x.ps1`), `-EncodedCommand` (`-enc`, `-e`, also glued: `-enc:<b64>`, `-EncodedCommand=<b64>`), a `-Command` glued to its parameter, a parameter PowerShell would not match by itself (each is matched as PowerShell does, by its aliases or a long enough prefix, with its value: `-ep`, `-exec`, `-of`, `-wo`, `-wi`, `-cu`; an unknown or ambiguous one such as `-in` or `-epo` counts) or one that loads code (`-Config`, `-ConfigurationName`, `-SettingsFile`, `-PSConsoleFile`, `-Login`, `-NoExit`), a script on stdin (`… \| pwsh`, `pwsh -c -`, `pwsh -s`, `… \| cmd`), `iex`/`Invoke-Expression` inside a `-Command` script, a `cmd /c` link or write target spelled with a `%VAR%` or `!VAR!` variable (`set X=…&& mklink /J %X% …`), an `xargs` or `parallel` command whose name stdin fills in, past `env` and wrappers (`echo touch \| xargs -I{} {} f`, BSD `xargs -J % % f`, `xargs -L1 env`, `xargs sh -c '$0 …'`), and a `find -exec {}`. Windows scripts are allowlists (#880): a PowerShell statement (a `-Command` script, Windows PowerShell's positional command, or the PowerShell tool's command) passes only as a read: a `Get-`, `Select-`, `Where-`, `Measure-`, `Sort-`, `Format-`, `ConvertFrom-` or `ConvertTo-` cmdlet, `ForEach-Object` (a member it names only a string read or a common property: `% Name`), `Out-String`, `Out-Null`, `Out-Host`, `Write-Output`, `Write-Host` and the other stream writers, `Test-Path`, `Resolve-Path`, `Convert-Path`, `Join-Path`, `Split-Path`, `Compare-Object`, `Group-Object`, `help`, a location change, their aliases (`gci`, `ls`, `dir`, `gc`, `cat`, `type`, `select`, `where`, `?`, `%`, `sort`, `measure`, `echo`, `pwd`, `cd`, `sl`…), an expression, a keyword, or a program PowerShell does not alias (judged as the same command in Bash, but `xcopy`, `robocopy`, `attrib`, `icacls` and other Windows writers, any `x.exe` or `x.bat`, and a script path count), with no redirection other than to `$null`, in a script with no call operator `&`, dot-source, static member on any receiver (`[X]::`, `$t::`, `$_::`), `$env:` assignment of a name that changes what a program runs or loads (`GIT_*`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `PAGER`, `EDITOR`, `VISUAL`, `PATH`, `PATHEXT`, `PSModulePath`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `BUN_OPTIONS`, `npm_config_*` in any case, `PYTHON*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`, `CARGO_*`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `DOTNET_STARTUP_HOOKS`, `COMPLUS_*`, `CORECLR_*`, in any case, as Windows reads names; in Bash `NAME=… prog`, `env NAME=…` and `export NAME=…` make every command from there a writer in its directory, but `PAGER=cat`, `GIT_PAGER=cat` and `GIT_OPTIONAL_LOCKS=0`), method call other than a string or collection read (`.Trim()`, `.Split()`; `.Delete()` and `.Invoke()` count), member assignment or `function:`/`alias:` drive; every other cmdlet (any `Set-`, `New-`, `Remove-`, `Add-`, `Clear-`, `Copy-`, `Move-`, `Rename-`, `Export-`, `Start-`, `Invoke-`…, `Out-File`, `Tee-Object`), alias (`sc`, `ri`, `rni`, `ac`, `md`, `ii`, `start`…) or function definition is a writer in its run dir; a `cmd /c\|/k` statement passes only as `dir`, `type`, `echo`, `cd`, `set` (display only), `where`, `findstr`, `find`, `ver`, `vol`, `tree`, `more` or `rem`, with no redirection other than to `nul`, and a command word spelled with a `%VAR%` or `!VAR!` variable (`%COMSPEC% /c …`, also in Bash and PowerShell) is a writer, so `copy`, `move`, `ren`, `md`, `rd`, `xcopy`, `robocopy`, `attrib`, `call`, `x.bat`, `if`, `for` and any program are writers in its run dir; `pwsh -c Get-ChildItem`, `cmd /c dir` and `xargs cat` run. `pwsh -wd X` (`-WorkingDirectory`) before the script reads the script's paths as after `cd X`; `-CustomPipeName` and `-Interactive` (`-i`) change nothing it writes. A read or a location change on a UNC path (`\\host\share`) passes, since it writes no file, but it can reach the network; `$(…)`; `unlink`, `chmod`, `rsync`, `find -delete\|-exec <writer>`, `xargs <writer>`, `awk -i`, `curl` writes: `-o` and `-O` under `--output-dir`, `-c`, `-D`, `--trace[-ascii]`, `--stderr`, `--libcurl`, `--hsts`, `--alt-svc`, `--etag-save`, `-w '%output{…}'`, also as any long-option prefix curl accepts; `mkfifo`; `wget` `-O`, `-o`, `-a`, `-P` or its run dir; `tar` `-x` (into `-C`) and the archive `-c\|-r\|-u` writes; `unzip` (into `-d`); git `init`, `clone`, `format-patch` (`-o`), `archive -o`, `bundle create`, any `--output`, `config` writes (`--global`, `--system`, `--file`), `fetch` (but a plain `git fetch [-q\|-v] [<remote name> [<branch>]]`), `gc` and `branch` writes, under `-C`, #790) count as a change in their directory (or their named files), and a denial for one names the command and the directory it runs in (#772), and `ln` sources are judged, so a link inside the worktree cannot point outside it, while the link a command creates is a write target (`ln`, with `-t`/`-st` or one operand, `mklink`, `New-Item`/`ni -ItemType SymbolicLink\|Junction\|HardLink` with `-Path`, `-Path:x`, `-Name` or a positional, also inside `cmd /c` and `pwsh -c` scripts, #880), so no link lands in the lead's checkout or outside a judge's scratch. Python or Node inline code (`-c`, `-e`, `-p`, `--print`, or a heredoc fed to `python3 -`/`node -`) that only reads changes nothing (retro 2026-11-17 C1/C2); it counts as a writer when it reaches past the modules Workit reads (#956): an import must be literal and in the tables (Python whole: `json`, `re`, `math`, `collections`, `itertools`, `functools`, `datetime`, `time`, `hashlib`, `base64`, `glob`, `fnmatch`, `csv`, `io`, `string`, `textwrap`, `statistics`, `difflib`, `shlex`, `pprint`, `typing`, `ast`, `tomllib`, `configparser`, `pathlib`, `urllib.parse`, `xml.etree.ElementTree`, `os.path`; members only: `os` (`path`, `getcwd`, `listdir`, `scandir`, `walk`, `stat`, `environ`, `getenv`, `sep`, `linesep`), `sys` (`argv`, `stdin`, `stdout`, `stderr`, `exit`, `version[_info]`, `platform`, `path`, `maxsize`), `yaml` (`safe_load[_all]`, `safe_dump[_all]`, `YAMLError`); Node, bare or `node:`, whole: `path`, `os`, `url`, `util`, `crypto`, `assert`, `zlib`, `querystring`, `readline`, `buffer`, any `*.json`; members only: `fs` and `fs/promises` (`readFile[Sync]`, `readdir[Sync]`, `stat[Sync]`, `lstat[Sync]`, `existsSync`, `accessSync`, `realpathSync`, `readlinkSync`, `createReadStream`, `promises`, `constants`)), so any other import, `require(<name>)`, `import(`, `__import__` or `from x import *` is a writer, and a module it binds is used only as `name.member` (`Object.entries(fs)`, `m = os`, `vars(os)` and `sys.modules` count); `node -e` has every builtin module as a global, so one outside the tables counts by name (`child_process.execSync`), `process` only through `argv`, `env`, `cwd`, `exit`, `exitCode`, `stdout`, `stderr`, `stdin`, `platform`, `version[s]`, `hrtime`, and `Bun` through `file`, `argv`, `env`, `version`, `inspect`; and ambient names count: a dunder, a private member (`._x`), `compile`, `globals`, `locals`, `vars`, `setattr`, `delattr`, `breakpoint`, `help`, `get_type_hints`, `ForwardRef`, a module reached through another (`glob.os`), and in Node a private member (`process.stdout._handle`), `constructor`, `globalThis`, `global`, `module`, `Function`, `WebAssembly`, `Worker`, `Deno`, `getPrototypeOf`, `getOwnPropertyNames`, a computed object key and a `flag`/`flags` option, which opens a read to write. A network call is not a write: confinement covers file writes only, so Node's `fetch` (a global) runs, while Python's `urllib.request` stays outside the tables because it also holds `urlretrieve`, which writes a file. Within the tables it still counts as a writer when it names a `MUTATING_CALLS` call outside string literals (bar a list's `append`/`copy` and `stdout.write`; `.copy(<arg>)`, `copy_into`, `move_into` and `ftruncate` count), runs code by name or deletes (`exec*`, `eval`, `getattr`, `unlink*`, `rename*`, `remove*`), opens a file other than by a plain path and a read mode or encoding, loads code by path (`require('<path>')`, `-r`, `--import`, `NODE_OPTIONS`, `PYTHON*`), calls through a computed name (`x['a'](…)`, `getattr`, a call on a returned value: `f(…)(…)`, `(0, f)(…)`, but not a function literal called at once), or holds text Workit cannot read (a variable, an unquoted heredoc with `$`, a backslash-newline joined first, also inside an unquoted heredoc's body; a quote or backtick left after reading the code left to right (#880): string and triple-quoted literals drop, an f-string or template literal reads as the code in its `{…}`/`${…}` (nested braces fail closed), a whole-line comment (`#` in Python, `//`, a block comment that starts a line) keeps its words but not its quotes, and a regex literal (where one may start: not after a name, number, `.`, `]` or quote unless the name is `return`, `typeof`…, so `len(a) / 2` divides) keeps its quotes; a `\u`/`\x` escape). Also writers: `Reflect`, `getOwnPropertyDescriptor`, `FileIO`, `.delete()` (a file's: a Map's `.delete(key)` reads), a one-argument `.replace(` (a path's rename: a string's takes two), `--env-file`, any `NODE_OPTIONS` or `PYTHON*` the command names (`export NODE_OPTIONS=…; node -e …`, `NODE_OPTIONS+=…`), `--eval=<code>`/`--print=<code>` read like `-e`, `python -m <module>` (also `-mpip`, `-Im pip`) but `json.tool` with at most one operand, `utime`, `ch(mod|own)`; `awk` with `system`, a print to a file or a pipe, a command's `| getline` or `-f`, `sed` with a `w`, `W` or `e` command, an `s///w` or `s///e` flag or `-f`, `deno eval`, `tsx -e` and `ts-node -e`; a script `xargs` or `find -exec` fills in (`{}` or an appended word) counts as one that writes. Such code, and any `ruby -e`, `perl -e`, `php`, `deno`, `tsx` or `ts-node` script, is judged by the paths it names (#744): its run directory counts as a write target, plus every absolute, `~` or `..`-climbing path in its text, options, arguments and env prefix; a relative `require`/`import` resolves to the run directory, and a path Workit cannot resolve is denied, so it passes only when run from the worktree, its scratch or a temp dir and naming no path outside them. Variables (#744, #772): a plain `NAME=<literal>` set earlier in the same command, `$(mktemp …)` (the path it prints), `$(pwd)` (the directory it runs in), `$PWD` after a literal `cd`, `pushd <dir>` or `popd` that starts its own `;` or newline segment and lands in an existing directory (not after `&&`/`||`, in a pipeline or `&`, through `command`/`builtin`, with CDPATH set or a function defined), and a `for` over literal words or words built from those, none holding whitespace or a glob, resolve, also in `workit … --cwd $W` and `workit check\|lock run --cwd $W`; a loop or conditional untrusts only the names assigned in its body, while `case`, `select`, functions, an IFS assignment (other than `IFS= read`) and a command-word `eval`/`source`/`declare` untrust every variable. `curl -K <config>`, `curl -w @<file>` and a command named by a variable (`$c -o …`) are unresolvable. A write through a variable Workit cannot resolve is denied naming it, with the command reprinted as `<absolute path of $T>` to spell out; a command substitution (`F=$(grep …)`) stays denied, naming it and the command to run first, with the assignment left out of the retry. L: `W=$PWD` after `&&` or `||` is not followed (the shell analysis does not record which operator a command follows). A write after a `cd`, `pushd` or `popd` whose target Workit cannot resolve (`cd -`, an unresolved variable, a glob, `$(…)`, `command cd`, `pushd` with no directory, `+N` or an option, `popd` with an argument, any `cd` inside a loop or conditional body) is denied until the path is spelled absolutely, with `git -C <worktree>` or `workit --cwd <worktree>`. Files outside any repository are host policy; an agent in a real linked worktree at `<repo>/.claude/worktrees/agent-<its id>` is left to the host (a look-alike directory, or a `.git` file naming another worktree's admin dir, is not); the launcher fast path never answers an implementer's edit, writing shell command or one of those writers, so those load the runtime. L: a script file an interpreter or shell runs (`python script.py`, `node x.mjs`, `source x`, `. ./x.sh`, `bash x.sh`, `./x.sh`) is not judged and stays allowed by design, since running the code under work is the job, a raw `git -C $W …` is not resolved through the variable (X, follow-up), nor are writers whose output path the analysis does not read: `cp -s\|-l` (links), `docker cp`, `ed`, `ex`, `vim -c`, `sqlite3`, and any other program that writes where its arguments or its own script say. This is a guard against hand edits, not a sandbox; the merge gate and non-author verdicts catch an out-of-scope diff. Read-only git is never denied. A denial is two lines (decision D3): what was refused, then `Retry as: <call>` (an interpreter run outside the worktree as `cd <worktree> && <command>`, an unresolved variable as `<absolute path of $T>`) or `Why:` when no call does the same | L: the permission `evaluate` hook gets the child session but no agent type, so a child is never bound to a worktree (a worker assignment could carry one: follow-up) | P `PreToolUse` for `agent_type` `workit-implementer`, same rules (the launcher loads the runtime for every implementer tool call); L: unverified that a subagent's `PreToolUse` carries `agent_id` and `agent_type` (`agentIdOnTool: partial`) | L: implementers are denied at `subagentStart`, so none runs to confine | L: no host subagents; supervised workers carry no agent type |
| Verifier/reviewer scratch confinement (#790, `hooks/worktree-confine.ts`) | N `PreToolUse` (edits, shell writes, mutating raw git) for `agent_type` `workit:verifier` and `workit:reviewer`: every write target must lie in `.workit-scratch/` at the root of a checkout of the hook cwd's repository (the lead checkout or one of its linked worktrees, resolved through symlinks), of any repository's Workit worktree (its admin dir holds the fanout token), or in the hook session's own temp dir in Claude Code's layout, `<tmp>/claude-<uid>/<project>/<session id>/` (never `/tmp` at large, and `$TMPDIR` stays unresolved); another repository's plain checkout scratch is outside; `/dev/null` is no target; any other, in a repository, the home dir or a temp dir, is denied naming the scratch dir of the hook cwd's checkout, with the same strict shell analysis as an implementer's (writers it cannot read count in their run directory, `ln` sources are judged, an unresolvable variable or `cd` is denied; git ref, config, worktree and push changes count in their repository). Also denied: an unquoted heredoc whose body holds `$(…)` or a backtick (`$((…))` arithmetic is not one; the shell runs it while writing the file, incident mwbalrwk); a shell reading a heredoc script (`bash <<'EOF'`, `sh <<< …`) whose script writes outside; and, saying to write the case to a scratch file and dispatch it from a test, a script Workit cannot read: a shell or interpreter fed by a pipe (`… \| bash`, `\| sh -s`, `\| env bash`, `\| python3 -`), `bash /dev/stdin`, `. /dev/stdin`, an interpreter reading stdin with no heredoc or from `/dev/fd/0` (a heredoc fed to `python3 -`, `node -` or `python3 /dev/stdin` is judged like inline code instead), `source <(…)`, `bash <(…)` and `eval`, also inside `$(…)`, `-c` scripts and `workit check --`. Workit verbs follow a judge table, so a new verb is denied: `workit check`, `dir`, `help`, `test-audit` (not `--mutate`), `ledger verdict\|list\|check\|ruling\|show`, `finding record\|list`, `pr status`, `ci wait\|logs`, `fanout status\|brief`, `models show`, `lock status`, `lease status`, `grant show`, `task show\|list` and `doctor --json` (exactly) pass, read past wrappers (`time`, `env`, `exec`, `!`, compound commands, `xargs`, `find -exec`, function bodies, alias bodies and uses, so `alias w=workit; w gc` is read as `workit gc`) and through `npx`/`npm exec`/`bunx`/`pnpm dlx` of `@workit-dev/cli`, `bun run workit` or `node`/`bun` on the CLI entry; `-h`/`--help` counts only right after `workit` or the verb, and any `--mutate…` or `--fix…` form is denied; a plain `git fetch [-q\|-v] [<remote name> [<branch>]]` passes in the judged repository or a Workit worktree, never in a scratch repository, and with no `:` or `+` refspec, `--prune`, `--force`, `-c` or `--upload-pack`; reads pass, `git status` included without `--no-optional-locks` (an index stat refresh changes no content, ref or config), and `git remote get-url` and `git range-diff` are reads. A command that reads a path from a shell variable is refused, never run: literal assignments before it (`W=/abs/path; git -C $W …`) or a `for` over literal words whose variable it uses, since a later command can set the name again under a spelling Workit does not see (`printf -v W"T"`, `declare`, `read`). The denial's `Retry as:` is the same command with each literal spelled in for `$NAME` and `${NAME}` (a loop unrolled, at most 16 words); a modifier or subscript after the reference (zsh's `$W:h`, `$W[1]`, `${W:-x}`) gets a `Why:` line instead. An assignment or loop name other than one ASCII letter or `wt`, `wd`, `dir`, `repo`, `root`, `base`, `sha`, `ref`, `branch`, `file`, `out`, `scratch`, `worktree` (all lower or all upper case), or one in the environment or read by git, a shell or an interpreter (`path`, `DIRSTACK`, `IFS`…), is refused even when the command never uses it. An assignment before git, as a prefix or `env`'s with no option (`A=b git status`, `env GIT_PAGER=cat git log`), passes unless it sets an implementer's loader name (the `$env:` list there; `PAGER=cat`, `GIT_PAGER=cat` and `GIT_OPTIONAL_LOCKS=0` pass), `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `XDG_*` or `LESS*` in any case (git's config and pager; a PowerShell `$env:` assignment of one is a writer too), or holds a value the shell expands. Setting `NODE_OPTIONS`, `PYTHONSTARTUP\|PATH\|HOME`, `PERL5OPT\|LIB`, `RUBYOPT\|LIB`, `LD_*` or `DYLD_*` is a script Workit cannot read. A denial is two lines (decision D3): the scratch confinement line naming the role, the agent id, its scratch dir and what was refused, then `Retry as: <call>` (a redirect or `tee` moved into that scratch dir, an interpreter run as `cd <scratch> && …`; inline code past the modules Workit reads names the reason on line 1, `` `import timeit` is outside the modules Workit reads in inline code (…) ``, and retries from scratch only when the script names no relative path, else its `Why:` names the read-only ways: `cat`, `jq`, `grep`, the Read tool, json/re/pathlib/fs reads, or a script file in scratch; an unquoted heredoc with its delimiter quoted, an unresolved variable as `<absolute path of $X>`) or `Why:` when no call does the same safely (a git write in the candidate, a verb outside the table); `workit fanout check` stays outside the table, since `git merge-tree --write-tree` writes objects. A judge's writes neither meet nor claim the live-session guard, since they stay in scratch; the launcher fast path never answers a judge's edit, writing command or one of those forms. L: the guard stops accidental writes; escapes through other tools are the OS sandbox's (#400): a script file in scratch the judge runs (`bash case.sh`, `bun case.ts`, `. case.sh`), a package script (`bun run`, `npm install`) or package binary (`npx <pkg>`), `node script.js` (running the candidate is the judge's job), a computed key held in a variable (`x[k]` once `k = 'con' + 'structor'`) or an options object built at run time, `make -f /dev/stdin`, `vim`/`ed`/`ex`, `fish`/`tcsh`/`deno run`/`lua`, `python -m` run in scratch, `git -c alias.x='!…'` or a pager, `git tag`; `gh`/`glab` calls are not judged | L: the permission `evaluate` hook gets no agent type; judge workers are read-only by assignment only | P `PreToolUse` for `workit-verifier`, `workit-reviewer`, same rules (the launcher loads the runtime for every judge tool call; the agents also run in a read-only sandbox); L: `agentIdOnTool: partial`, as for implementers | L: `subagentStart` role markers only; no per-subagent tool hook to confine | L: no host subagents; a supervised judge worker gets read tools and Workit's only (no shell, write or edit: `worker.ts` `roleTools`) |
| Worktree dependencies (#310, #934, `worktree-deps.ts`) | N: `workit fanout worktree create` runs the worktree's own frozen install (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable`/`--frozen-lockfile`, `npm ci`; its whole process tree killed after `--install-timeout`, default 5m; the workspace keys `fanout.deps` and `fanout.installTimeout` set both, the flags override them). A missing package manager, a failed install or a timeout, and `--deps link`, mirror the main checkout's git-ignored `node_modules` (and `*/node_modules`, `*/*/node_modules`) one level deep instead: relative links (workspace packages, `.bin`) resolve inside the worktree, installed packages link to the main checkout's (866 entries in 18 ms on this repository, against 342 ms for a warm-cache bun install), and the create output, `--json` `deps`, the brief's `DEPS: LINKED` line and the verifier SPAWN line say so; skipped with a note when git does not ignore `node_modules`. Every host reads the same create output and brief text | N: same CLI | N: same CLI | N: same CLI | N: same CLI |
| Role models (#395, #654, D1: `models.roles`, `fanout.tierModels` as implementer tiers; a role's model lives in the host's own agent definition, a model named on a spawn wins, and no spawn is denied over model or effort unless `models.enforce: "strict"`; `workit models show` says per host and role `agent file`, `spawn fill` or `advisory` and the enforce mode; L on every host: `models.lead` is advisory, no hook sets a session's own model) | N: plugin agents carry `model:`/`effort:` frontmatter (honored for plugin agents on 2.1.327; `permissionMode`, `hooks`, `mcpServers` are not): `workit:implementer` and `workit:verifier` sonnet, `workit:reviewer` opus, `workit:decider` fable/high, `workit:babysitter` haiku; `Explore` keeps its own. A role configured to another value, `Explore` with `models.roles.explore` and a `general-purpose` spawn (`models.roles.default`, or an old prompt's `ROLE: <role>` line) are filled on a spawn that names no model: outside auto mode through `updatedInput` with a note naming what to pass (W2.21); under auto mode (`permission_mode: "auto"`, which refuses a rewritten Agent call) the spawn runs as written and the lead gets one context line naming the model that ran and the configured one. A named `model` or `effort` is never changed. `strict`: a configured role model beats a named one unless `models.allowLeadOverride`, and auto mode denies once in two lines (the spawn-args reason, then `Retry as: Agent <exact args>`). The SessionStart contract says to spawn roles by name with no model and lists only roles configured to differ from their agent file; the fanout brief's `SPAWN:` lines keep the exact args. L: a user `~/.claude/agents/<name>.md` cannot override a namespaced plugin agent, so a per-workspace value rides the spawn | N: the plugin registers `workit-implementer`, `-verifier`, `-reviewer`, `-decider`, `-babysitter` through `ctx.agent.transform` (`AgentEditor.update` creates a missing id on 2.3.0), `mode: subagent`, `system` from the canonical agent body, `model` from `models.roles` for the project root (implementer only when its tiers agree; none: the parent's), edit denied for judges and the decider, and `ctx.agent.reload()` when `workspaces.json` changes; `execute.before` fills only a spawn that names no model (implementer tiers, `general`/explore roles, a role agent's usage-limit fallback); a named model is kept unless `strict`; a continuation keeps its child's model | N: `model` and `model_reasoning_effort` written into the copied `workit-*` agent TOMLs (implementer, verifier, reviewer, decider, babysitter) only for a configured role (the implementer only when its tiers agree); L: a value in the file overrides spawn values; `explore` and `default` are advisory | N: the plugin manifest's `agents` path ships `workit-verifier`, `-reviewer`, `-decider` (`permissionMode: readonly`) and `-babysitter`, rendered from the canonical agents with no `model:`; L: plugin files are static, so a configured role is advisory (the parent passes the Task tool's `model`); implementers stay denied at `subagentStart` | N: `--model`/`--thinking` on a supervised worker for a configured role, ambient (no flags) otherwise; L: `verifier`, `default`, `decider` and `babysit` are advisory (no host subagent to set them on) |
| Usage-limit fallback (#655, `core/model-fallback.ts`; behaviour per host in [usage-limit fallback](../guides/configuration.md#usage-limit-fallback)) | N: the Agent `PreToolUse` hook scans recent transcripts and `SubagentStop` (W2.19) the stopped worker's last message; L: Anthropic models only, so a fallback stays within Claude families | N: `execute.after` on a `subagent` call marks the limit, the next `execute.before` sets the next model | P: agent TOMLs are written at launch, so a fallback applies from the next session; L: nothing marks a limit | L: advisory: `workit models show` names the model to pass | P: a supervised worker gets the fallback at launch; L: Pi marks no limit itself |
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
| ytrack agent skill (youtrack-cli #16): ytrack 0.6.0+ installs and refreshes it (`ytrack skill install|sync`); doctor `ytrack_skill` reads `ytrack skill list --json`; `workit upgrade` removes the per-host copies an older Workit recorded once `~/.agents/skills/ytrack` exists | N ytrack's own `~/.claude/skills/ytrack` ([Claude Code skills](https://code.claude.com/docs/en/skills)); Workit keeps it | N reads `~/.agents/skills` ([OpenCode skills](https://opencode.ai/docs/skills/)); Workit's old `~/.config/opencode/skills/ytrack` removed | N reads `~/.agents/skills` ([Codex skills](https://developers.openai.com/codex/skills)); Workit's old `~/.codex/skills/ytrack` removed | N reads `~/.agents/skills` ([Cursor skills](https://cursor.com/docs/context/skills)); Workit's old `~/.cursor/skills/ytrack` removed | N reads `~/.agents/skills`; Workit's old `~/.pi/agent/skills/ytrack` removed |
| YouTrack update under one yes (`workit youtrack update`, `create --attach/--command`) and the raw-ytrack routing to it (`hooks/ytrack-guard.ts`); `ytrack auth paths` folder map (doctor `ytrack_paths`, setup) | N CLI verb; guard asks or denies as for other raw ytrack writes | N CLI verb; guard denies via `permission.evaluate` | N CLI verb; guard denies via the hook | N CLI verb; guard denies via `beforeShellExecution` | N CLI verb; guard blocks via `tool_call` |
| Continuing a reported worker (#313) | L: no continuation gate; a subagent turn is resumed natively, so the lead follows `fanout brief --mode resume` by convention | N: `subagent` with a `sessionID` is refused (`delegation_lineage_denied`) unless the worker is running or its worktree has uncommitted changes; the refusal prints `workit fanout brief <slice> --mode resume` | L: no continuation gate | L: no continuation gate | L: no host subagents |
| Owned CLI on the agent's PATH (#648, `core/cli-locate.ts`) | N: the plugin's bundled `bin/workit`, unchanged | N: `shell.create.before` adds `opencodeShellEnv()` to every agent shell's env (`src/cli-path.ts`); a V2 build with no shell domain applies it to the plugin process, whose shells inherit it | P: the hook entry (`hooks/launcher.ts`) and the MCP server (`scripts/launch-mcp.ts`) apply it to their own process, so what they run or probe is the owned CLI. L: no hook or MCP answer changes the agent's shell env | P: the hook process (`hooks/workit-hook.ts`) applies it to its own env. L: no hook changes the agent's shell env | N: the extension applies it to Pi's process env when it loads (`src/cli-path.ts`); the bash tool inherits it |
| `base_red` cause on `pr merge` (#750, `forge/merge-gate-base-red.ts`): the previous base run decides likely flaky (unblock `workit ci rerun --ref <base> --check "<job>" --reason flake`), `<base>` is broken (no rerun) or unknown | N: CLI | N: CLI | N: CLI | N: CLI | N: CLI. On every host the classification is GitHub-only: GitLab always gets `unknown` and the generic `--failed` rerun hint (X: `Forge.commitChecks` for GitLab, follow-up) |
| Configured checks at judge start (#751: `ledger verdict verified\|tests-verified` refuses `check_missing` without a fresh passing local run or green PR CI on the head; the refusal is the CLI's on every host) | N `SubagentStart` for `workit:verifier`/`workit:reviewer` lists each configured check as `workit check <name>`, "or cite green CI on the head" | X: the child's context hook could carry the list, unused; the CLI refusal names the checks | N `SubagentStart` for `workit-verifier`/`workit-reviewer`, same list | L: `subagentStart` cannot add context; the CLI refusal names the checks | L: supervised workers have no shell tool, so they record no verdict |
| Deslop fresh-eyes no-comments pass (#754, `focused` lane and up; [review.md](../guides/review.md)) | N: the `workit:reviewer` agent gets the diff and the keep list | N: a child session | N: the `workit-reviewer` agent | P: a Task subagent marked `ROLE: reviewer`; L: `subagentStart` cannot add context, so the diff and keep list ride the task prompt | P: a supervised worker; L: supervised workers have no `bash`, so the lead runs `workit deslop scan --diff` and `workit test-audit` and passes their output |
| Local weak-model bench (#749, `scripts/eval/run.ts`, [eval.md](eval.md)) | N: each case runs as a headless `claude -p` with `--plugin-dir` on the checkout, graded from the transcript's tool calls | N: `--host opencode` runs each case through `opencode run` ([eval.md](eval.md)) | X: no runner yet (follow-up) | X: no runner yet (follow-up) | X: no runner yet (follow-up) |
| Hook older than the CLI (`hook_issued_sessions`) | N: the installed hook bundle is read for `ISSUED_SESSIONS_MARKER` | L: issues no subagent ids (children derive theirs) | N: every hook chunk in the plugin cache is read for the marker | L: `subagentStart` cannot add context, so no ids are issued | L: no host subagents; workers derive theirs |
| Verdict held to its checks' head (`head_moved`, `ledger.ts` `sessionOwnsRun`): an independent `verified`/`tests-verified` verdict is refused when its session's latest run of a check ran on an older head and a code change landed since; a `<lead>:<agent>` verifier is held to its own runs, a lead's plain session not to its subagents' (#883). Each check row records where its agent id came from (`agentFrom`: `stamp` a claimed stamp, `none` a host and no stamp, `env` no host's `WORKIT_AGENT_ID`); a verdict whose session a hook issued or whose host is Claude Code or Codex is held only to `stamp` rows (#972), other hosts keep the rules below | N: no Claude Code shell carries a subagent id, and a hook cannot add one (a `WORKIT_AGENT_ID=` prefix through `updatedInput` loses the call's `Bash(workit <verb> *)` allow rule, and auto mode refuses a changed call), so `PreToolUse` stamps each plain `workit …` call with the calling `agent_id` (`src/agent-stamp.ts`, `<state>/agent-stamps/`; the lead's calls too; a guarded registry like `verdicts`, so an agent's shell or edit tool cannot plant one; `PostToolUse` drops a finished call's unclaimed stamps, a background call's stay) and the CLI claims the stamp its session and argv name as `WORKIT_AGENT_ID`. A subagent `S:a` is held to, and cleared by, only its `stamp` rows of session S and agent a, the lead S only its `stamp` rows with no agent id; a `none`, `env` or older row, and one under the whole `S:a`, are nobody's. The launcher sends a subagent's `workit` call to the runtime, and a lead's too while a subagent's stamp waits unclaimed (so one argv from both is ambiguous and neither claims). Under any host the CLI ignores an exported `WORKIT_AGENT_ID`: only a claimed stamp names the agent. A host is read from `WORKIT_HOST` or from a variable the host itself sets (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`, `PI_SESSION_ID`), so clearing `WORKIT_HOST` alone still reads as a host. `hooks/identity-env.ts`, a guard against careless changes, not a sandbox, denies for the lead and every subagent a command that sets, unsets or empties `WORKIT_AGENT_ID`, `WORKIT_HOST`, `WORKIT_SESSION_ID` or `WORKIT_SESSION_TOKEN`, and, in a command that runs `workit`, a change to a host's own variable (`OPENCODE_SESSION_ID`, `PI_SESSION_ID`, `CODEX_THREAD_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, #981; `grep CODEX_THREAD_ID` and `env -u CLAUDECODE claude -p` still run), `env -i`/`env -` (clearing every variable, the host's own included; `env -i ls` still runs) or env/unset arguments it cannot read (an unknown `env` option, a shell-expanded argument to `env` or a declare builtin). The launcher sends such a command to the runtime. Codex gets the same deny; Cursor and OpenCode do not stamp and leave these variables alone. L: the guard reads a prefix assignment, `env` or `env.exe` (its options by arity: `-u`, `-C`, `-S` lines, `-a`, BSD `-P`, clusters and `=` forms, and the assignments after `--`), the wrappers in write-gate.ts's table before it (`sudo`, `timeout`, `nice`, `setsid`, `ionice`, `stdbuf`, `chrt`, `taskset`, …), `busybox env` and `toybox env`, the declare builtins (`export`, `unset`, `declare`, `typeset`, `local`, `readonly`), `bash -c`, `su -c`, `runuser -c` and `script -c` scripts, and PowerShell `$env:NAME`/`Remove-Item env:NAME`. In a command that runs `workit` it fails closed: a `$` or backtick in an `-S` or `--split-string` line, any shell-expanded `env` argument (so `env FOO=$(date) workit …` is denied too), and any env change inside a wrapper it does not follow (`watch`, `strace`, `chroot`, `flock`, `ssh`, `su`, …) or after a command it does not know whose words hold an `env` (`unshare`, `pkexec`, `nsenter`, `run0`, `docker run x env …`); `docker run x env FOO=1 ls` still runs. It does not read `read`, `printf -v`, `${X:=}`, `for X in`, `source`, an interpreter, a script file, or control flow (`… && { export …; }`, a `while` body, a function), so a deliberate change there passes. A forged id binds nothing: no shell or edit tool can plant a stamp, and a run no stamp named holds and clears no verdict; issued sessions and tokens decide who may record one. On every host, host session variables that disagree vouch for nothing (#981, #986): two or more of `OPENCODE_SESSION_ID`, `PI_SESSION_ID` and `CODEX_THREAD_ID` (each host sets only its own; an OpenCode child or Pi worker names its lead in `WORKIT_SESSION_ID`), or any two of the shell's host names that disagree (`WORKIT_HOST`, Claude Code's `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`, Cursor's `CURSOR_AGENT`, and each host session variable as its own host's name; a `WORKIT_HOST` set to match a forged variable does not outvote a mark), refuse a verdict (`--self` included) or commit as `foreign_host_session`. L: a real OpenCode, Pi or Codex session started from another host's shell reads the same, so it records from a shell no other host started; replacing the shell's own variable (`OPENCODE_SESSION_ID=x` in OpenCode) is caught only by the identity guard, which runs where hooks stamp. L: a `workit` call inside `bash -c`, a `$(…)` substitution, a script fed on a heredoc or a package script, a word the shell expands, or one argv run by two actors within 2 minutes claims no stamp: the run is bound to no agent (`none`; the CLI prints the plain `workit check <name>` to rerun), so it holds and clears no verdict, the lead's own included | N: a child derives its own session (`WORKIT_SESSION_ID=<lead>:<child>` in its shell) and runs its checks under it; `sessionOwnsRun` takes those rows as the child's | P: the same stamp as Claude Code where a subagent's `PreToolUse` carries `agent_id` (descriptor `agentIdOnTool: partial`); L: unverified on a live Codex (codex-cli 0.171 is installed, but an isolated `CODEX_HOME` has no credentials and the user's own Codex home stays untouched) that a subagent's `PreToolUse` carries `agent_id` and that its shell shares the lead's `CODEX_THREAD_ID`; where it does not, nothing is claimed and the rows are `none`, so they hold no verdict (a Codex with no hooks holds none at all) | L: tool hooks carry no subagent id (`hooks/hosts/cursor.ts`), so nothing is stamped; no subagent ids are issued either, so a verdict and its checks share the shell's session | N: a worker runs with `WORKIT_SESSION_ID=<lead>:<worker>` and its rows carry it |

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
  the registries unhindered. It is a guard against hand edits, not a sandbox
  (#329 moves the state into the DB). What survived the second attempt (ledger
  decision mwcyh6ku, #818), every host:
  - (L) A program that computes the guarded path at run time (a script that
    joins or decodes it, a binary, a package script, `make`) is not seen by any
    hook on any host; only the host OS sandbox stops it.
  - (L) A shell script produced at run time (`bash -c "$(…)"`, `curl … | bash`)
    or changed after the hook read it is not judged.
  - (L) A path the command computes at run time (`$(…)`, a `read` variable,
    text piped from a program that is not a literal `echo`, `printf` or `cat`)
    is not resolved. Interpreter code that builds a write target from a
    guarded dir and such a value is denied as a target Workit could not
    resolve, without naming the dir (#837); an interpreter reading its script
    on stdin (`python3 - "$F" <<'EOF'`, `bash -s`) is judged by that script,
    never by its arguments.
  - (L) A variable whose value in the command shell differs from the hook's own
    environment is not resolved.
  - A link or mount whose source is or holds a guarded path is denied when the
    command makes it, so a write later in the same command (before the link
    exists, when the hook reads it) cannot pass through it: `ln` (hard, `-s`,
    `-f`, `-T`, `--symbolic`), `cp -s|-l|--link|--symbolic-link`, `install -l`,
    `rsync --link-dest` (a relative dir read from the destination), `mount`,
    `bindfs`, and on Windows `mklink` (`/D`, `/J`, `/H`) and
    `New-Item`/`ni -ItemType SymbolicLink|Junction|HardLink`. A `cmd /c "…"` or
    `pwsh|powershell -Command "…"` script is read statement by statement (`&&`,
    `&`, `||`, `|`, `;`), and `xargs` or `parallel` is judged with the words
    its stdin feeds it filled in (a heredoc, a here-string, a literal `echo`,
    `printf` or `cat` pipe, or `:::` arguments). A `pwsh -File` script, an
    encoded command (also `-enc:<b64>`), a script on stdin (`… | pwsh`,
    `pwsh -c -`, `… | cmd`), `iex`, a `cmd` `%VAR%` link name and a command
    stdin or `{}` names for `xargs` (BSD `-J` too) or `find -exec` count as a
    writer in the directory they run in (#880). On Windows a
    command with unquoted `C:\…` paths is judged a second time with them
    spelled with `/`, since a POSIX shell drops the `\`. A source holds one when it is an ancestor of the state or a config
    dir, a repository's root, git dir or `workit` dir holding a ledger, or an
    ancestor of the ledger of the repository the command runs in.
  - (L) A hard link made and written inside a program Workit cannot read is not
    seen, nor a link to an ancestor of another repository's ledger (beyond its
    root, git dir and `workit` dir).
  - (L) A command handed to a scheduler (`at`, `crontab`, `systemd-run`) is not
    judged.
  - (L) An archive extracted into a directory above a guarded path is judged by
    its destination only; its contents are not read.
  - (L) On Claude Code and Codex the launcher sends a shell command to the
    runtime by its text: git/gh/glab, a script run, a guarded name, a
    user-only Workit call, or, in a checkout with a task store (and always on
    Windows or PowerShell), a writer verb (`sponge` included) or a file
    redirect (an fd duplication such as `2>&1`, `>&2` or `>&-`, and
    `>/dev/null`, are not writes; `>& file` and `>&file` write the file, #843).
    With no task store a write goes to the registry guard only when
    `hooks/write-reach.ts` `mayReach` says it may reach a guarded path: no verb
    list, every word read as a path from every directory a `cd` reaches,
    through symlinks (a dangling one is followed to the file a write through
    it creates, #837), hard links, `~`, the hook's own env for an unset `$NAME`,
    and any glob, brace or set variable near a guarded dir's ancestry; it says
    yes to every spelling it does not resolve (`~user`, `$'…'`, `${X:-…}`, a
    `cd` with no literal target, `popd`, `CDPATH`, more than 64 words, and any
    link or mount form above). A
    Claude Code edit goes to the runtime with a task store, for a confined
    agent, or when its file may reach a guarded path. A write whose text
    hides every marker (a program that writes where its own code says) is not
    seen.
  - (L) In a checkout with no task store, a plain write inside the working
    directory is answered by the launcher, so the live-session guard neither
    claims nor refuses there.
  - (L) Tool calls no Workit hook is registered for are not guarded: MCP server
    tools, Claude Code Monitor, Codex `write_stdin`, Cursor edits that name no
    path, tools from other Pi extensions; and every hook fails open when its
    runtime cannot load (#820).
  - (L, #815) Any proof kept in files the agent's OS user can write is
    forgeable by that user.
  - (P) Removing a directory above a guarded path is not denied; it can only
    remove grants or approvals.
  - (P) An inline interpreter that only reads a guarded file is denied: use
    `workit grant show`, `cat` or `jq`.
- The Claude Code launcher's fast path and the Codex launcher's quiet path
  send any edit or shell command whose text names `issued` or the state dir,
  or that `mayReach` says may reach a guarded path (held sound against the
  gate itself by test/workit-core/hooks/write-reach.test.ts), to the runtime,
  so a checkout with no task store is guarded too. Windows paths
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
- **Budget and queue** (#857, #884): admission is a weighted budget in units
  (`resources.slots`, or a units `budget` with `weights`) and memory (RAM less
  `reserve`, each check charged its measured peak RSS), behind a pressure gate
  (PSI on Linux, load and CPU elsewhere; at most 5 min). The queue serves the
  shortest measured run first with 5-minute aging and backfills smaller
  waiters that fit. `WORKIT_NO_PRESSURE_GATE=1` turns the gate off (the test
  preload sets it). User docs: [checks](../guides/checks.md#waiting-for-the-heavy-check-lease)
  and [heavy-check budget](../guides/configuration.md#heavy-check-budget).

Host-approval channel limits ([host-approval.md](../workit-next/host-approval.md);
#419, #649, #768, #774, #864). The registry, `workit approve`, the Claude
Code and Pi recording and the consume API live in `approvals/store.ts`; the
`workit youtrack` writes and `workit release notes approve <v>` use it, asked
on the call itself where the host can (`approvals/inline.ts`, decisions
mwf752f2 and mwf752sv). One live request per
hash: a refusal reuses it. Every host keeps the terminal fallback: the user
runs `workit approve` at a real TTY, with an id only when several requests
wait (L, D18: a pseudo-terminal passes it). The
issued-registry guard covers `<state>/approvals/` too ([Host parity](#host-parity)).
A host acts only on one plain `workit approve <id>…` call (`approvals/call.ts`):
a chain, substitution, leading `cd`, env prefix, redirect or `--cwd` is denied
with the plain form (Claude Code, Pi; Codex, Cursor and OpenCode deny or ask on
the user-only call as before). `consumeApproval` accepts only a terminal grant
(`host: terminal`, no `toolUseId` or `observer`) or a Claude Code or Pi grant
whose `asked` row names the same host and hash. L (D18): the `asked` row is a
hand-edit check, not proof; a forger who writes both files or calls the store
library passes it, and real unforgeability needs another OS principal.

- **Claude Code:** N, on the action itself for the YouTrack writes: `PreToolUse`
  on a plain `workit youtrack note|time|meeting|update|create` answers `ask`
  with the full text (cut after 60 lines with "N more lines") and an
  `updatedInput` that prefixes `WORKIT_APPROVAL_TICKET=<random>` to that one
  call (claude 2.1.323 keeps an asking hook's `updatedInput`); the store keeps
  only the ticket's sha256 with the call's argv and content hashes (words plus
  the bytes of each file it names) for 2 minutes, a newer ask for the same
  call closes older ones, and the verb uses it once, only from the asking
  host session, after reading each named file once and posting exactly those
  bytes. L: no subagent id reaches a Claude Code shell, so lead and subagent
  tickets are kept apart by delivery and the replay deny. A wrapped call (pipe,
  chain, redirect, `bash -c`, variable, leading `cd`) is denied with the plain
  form. The launcher sends these calls to the runtime (`bin/workit-hook.mjs`
  `WORKIT_INLINE_ASK`), and any tool input naming `WORKIT_APPROVAL_TICKET` or
  `WORKIT_APPROVAL_UNASKED` too. Replay: only the hook's rewrite carries a
  ticket. A shell command naming either (quotes and backslashes removed) is
  denied by the shell gate every host runs (`ytrackGate`, also OpenCode's
  `permission.evaluate`), and a file write whose input names either is denied
  on every host: `handle.ts` `write.pre` reads the event's `text`, which each
  adapter fills from its write tool's input (Claude Code `Write`/`Edit`, Codex
  `apply_patch`, Cursor `preToolUse` write tools, Pi `write`/`edit`); OpenCode's
  `permission.evaluate` sees paths only, so its plugin checks the write tool's
  args in `execute.before` (`checkWriteArgs`, the same test). Turn binding:
  `UserPromptSubmit` closes every unused ask of the session and the lead's
  `Stop` its own, so a rejected prompt's ticket dies with its turn and a name
  built at run time or a file an interpreter writes has nothing left to
  replay. Write tools reach the runtime on every launcher (Codex sends
  `apply_patch` there). L: Codex's and Cursor's shell fast paths do not route
  a command naming the variables; no ticket is ever minted there. For `workit
  approve <id>`: `PreToolUse` asks with the request rendered from the
  store and writes `asked` (one hash per id) in `default`, `acceptEdits`,
  `plan` and `auto` (auto mode's classifier never answers a hook's ask: the
  person sees it, #864); `PostToolUse` of the same `tool_use_id` writes one grant per id
  from argv. Claude Code fires `PostToolUse` only for a call that succeeded
  (a failure is `PostToolUseFailure`, not registered); a sent non-zero
  `exit_code` records nothing. The adapter's parse sets the approve step and
  its render applies it (`dispatchHook` runs both in one synchronous call);
  the launcher's fast path sends every `workit approve` call to the runtime on
  both events (`bin/workit-hook.mjs` `WORKIT_APPROVE`). Setup adds the `ask` rule `Bash(workit approve*)`. L: a grant proves the call
  ran after an ask, not that a person answered, and no hook sees a reject.
  L: `bypassPermissions`, `dontAsk`, an SDK `canUseTool` callback and
  `--permission-prompt-tool` answer without a person, so they record nothing
  (an `sdk-*` `CLAUDE_CODE_ENTRYPOINT`, which `claude -p` and the SDKs set,
  records nothing either); a YouTrack write there runs with
  `WORKIT_APPROVAL_UNASKED=<mode>` and the verb refuses naming it. Release
  notes (#864, `approvals/release-notes-ask.ts`): a plain `workit release
  notes approve <v>` is asked on the same way, its user-only ask replaced by
  one showing the whole draft (no line cap); the ticket binds the call's
  words and the draft text's sha256, the verb reads the draft once, consumes
  the ticket and records `release.notes.approved` with `via: host`. In a mode
  where no person sees a prompt it runs unasked and the verb refuses with one
  terminal command. L: a `--package <name>` call is not asked on (its tag
  needs the config, which the hook does not read); the user-only ask stays and
  the verb refuses in the agent shell, so the agent uses the tag form
  (`pkg-a@0.1.0`). L: the grant's
  `asked` row (host `claude_code`) catches a hand edit, not a forger.
- **OpenCode:** fallback-only, YouTrack writes included: the verb refuses with
  one short terminal command (`workit approve`). The user-only call is asked as
  before; the CLI records nothing in its shell. L: no hook can rewrite a call's
  input with an ask, so there is no ask on the action itself. U: `permission.asked`/`permission.replied` are
  in the installed types but unused by Workit, `question` has no reply event
  there, and a `subagent` spawn may not pass `permission.evaluate`. A grant
  naming `opencode` is refused. Release notes: terminal-only; `workit
  release notes approve <v>` stays user-only and the verb refuses in the
  agent shell with one terminal command.
- **Codex:** fallback-only. The rules file prompts on `workit approve` and the
  `PreToolUse` hook denies it as a user-only call. L: the hook can deny but not
  ask; prompts come only from prefix rules. U: the `permission_mode` values
  under `approval_policy = never` and how a "don't ask again" answer caches.
  A grant naming `codex` is refused. L: no ask on the action itself (the hook
  cannot ask or rewrite); a YouTrack write refuses with `workit approve`, and
  release notes are terminal-only (the user runs `workit release notes
  approve <v>` in their terminal).
- **Cursor:** fallback-only. `Shell(workit approve)` is a `permissions.deny`
  entry and `beforeShellExecution` denies it. `afterShellExecution` is offered
  but not registered (X). U: whether auto-run skips an `ask`. A grant naming
  `cursor` is refused. L: `beforeShellExecution` cannot rewrite a call, so no
  ask on the action itself; a YouTrack write refuses with `workit approve`,
  and release notes are terminal-only.
- **Pi:** N in the TUI: the `tool_call` hook shows `ctx.ui.select` (Approve once
  / Reject / Edit) with the stored request, writes the grant (or the rejection;
  Edit closes the request) and blocks the shell call with a result naming the
  answer; a dismissed dialog records nothing. Print mode has no dialog
  (`hasUI` false); in RPC mode the dialog goes to the RPC client, which may be
  a program, so RPC is fallback-only (L): the shared gate denies the call.
  The hook writes an `asked` row (host `pi`) before the grant; L: it catches a
  hand edit, not a forger. On the action itself (#864): a plain `workit
  youtrack …` write shows its full text in `ctx.ui.select` (Approve once /
  Reject) on the tool call; Approve records the ask (only after the yes, so a
  rejected dialog leaves nothing to reuse) and mutates the command to carry
  its ticket, and the verb posts in that call. A plain `workit release notes
  approve <v>` shows the whole draft the same way, the dialog its only gate
  (as for `workit approve`), and the verb records the approval in that call;
  a `--package <name>` call is not asked on (denied as user-only). Print and
  RPC fall back to the terminal line; release notes there are terminal-only
  (the shared gate denies the user-only call).

## Design background

`docs/workit-next/` holds the research, spec, slice plan and design for the
3.0–7.0 redesign (slices S0–S22 shipped; S23 deferred). It explains why the
current model looks as it does, but it is a dated record, not kept in step
with the code: later work such as the 7.1 release tracks is not in it.
`docs/archive/` holds earlier, superseded specs.
