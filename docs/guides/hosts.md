# Hosts: OpenCode, Cursor, Codex, Pi

All hosts share one core and the same eleven skills. Each adapter maps the
contract onto what the host can actually observe; where a host cannot attest
something, Workit labels it `agent_guided` instead of pretending. Claude Code
has [its own guide](claude-code.md).

Every `workit_<family>` tool (MCP, OpenCode, Pi) takes one flat object:
`action` plus primitive or string-list fields (for example `workit_policy`
`{action:"assess", riskTier:"normal", behaviorChange:true}` or `workit_task`
`{action:"start", objective:"…", paths:["src"]}`). Omit `taskId` and
revisions; nested payloads from older versions still work.

**Before-write gate.** When the branch task has an open product choice or
needs a plan ([verification](verification.md)), working-tree edits are denied
with the exact unblock on OpenCode (permission evaluate: edits and recognizable
shell writes), Cursor (`preToolUse` write tools), Pi (`tool_call` write/edit
and bash), Codex (`PreToolUse` on `apply_patch`, with the files read from the
patch, and on recognizable shell writes such as `echo x > src/a.ts`) and
Claude Code. A patch whose files cannot be read is treated as writing code.

**Raw git and forge commands.** Workit's delivery rules (merge grant and
verdict gate, protected branches, the session trailer) live in its own verbs,
so every host's shell hook steers raw commands toward them. Inside a Workit
workspace (a repository with a Workit store, or one `workspaces.json` matches):

- `gh pr merge`, `glab mr merge`, and `git push` onto a protected branch or
  the default target (`git push origin HEAD:main`, `--force` or not, a bare
  `git push` while on `main`, `--delete main`) are denied with the command to
  run instead: `workit pr merge`, `workit git push [--force-with-lease]`.
- `git commit`, a feature-branch `git push`, `gh pr create|view|checks` and
  `glab mr create|view` run, with a one-line nudge naming the workit verb.
  Each kind of nudge (commit, amend, push, force push, PR create, PR read)
  shows once per session; a command that also runs a workit verb (`gh pr view
  4 && workit pr merge --pr 4`) gets none. Denies are not throttled.
  Read-only git (`status`, `log`, `diff`, `fetch`) gets nothing.
- A raw `git commit` (or `--amend`) is recorded as the session's
  `commit.recorded` ledger row, so that session's own verdict is never
  accepted as independent. The pre-tool hook notes HEAD; only a commit that
  moved HEAD, was made after the note and is not claimed by another session
  (a ledger row or `Workit-Session` trailer) is recorded, so a failed commit
  never records someone else's HEAD.
- `--help`, `git push --dry-run` and a push to a remote other than the one
  workit pushes to (a fork) are never denied.

Commands are parsed as text (chains, `cd x &&`, `( … )` subshells,
`pushd`/`popd`, `git -C`, env prefixes, `bash -c '…'`, and PowerShell quoting
for Claude Code's PowerShell tool); a directory that cannot be known (`cd -`,
`cd $X`) gets no decision. Git is spawned only to read a new commit and, before
a deny, the push remote. The hooks fail open
and never grant permission: host allow/deny rules stay authoritative. The one
exception is OpenCode's `ask` for Workit's own delivery verbs (below).

## Host permissions (`workit setup`)

Plugins cannot ship permission rules, so without help every host asks (or, in
Claude Code's auto mode, a classifier judges) each `workit pr merge` or
`workit git push` even though Workit's grants and non-author verdicts already
gate them. `workit setup` writes a Workit-owned block into each host's own
config after one consent:

```bash
workit setup --dry-run                 # show the diff, write nothing
workit setup --hosts=claude-code       # show the diff, ask, write
workit setup --hosts=codex,cursor --yes
```

It allows only the delivery and state verbs `git`, `pr`, `ci`, `stack`,
`release`, `task`, `ledger`, `evidence`, `finding`, `decision`, `worker`,
`verify-delivery`, `policy`, `doctor`, `help` and `workit --version`. Never
`check` or `lock run` (they run any command), `grant` (authority), `fanout`,
`test-audit`, `gc`, `init`, `upgrade` or `uninstall`. It refuses inside an
agent session (`CLAUDECODE`, `WORKIT_SESSION_ID`, `CODEX_THREAD_ID`,
`OPENCODE_SESSION_ID`, `PI_SESSION_ID` or `CURSOR_AGENT` set) and prints the
command to run yourself. `workit uninstall` removes exactly the entries it
added (recorded in Workit's state dir), `workit upgrade --apply --confirm`
refreshes a block it already wrote (the diff is in the preview), and `workit
doctor` has a `claude_permissions`, `codex_permissions` and
`cursor_permissions` row.

| Host | What `workit setup` writes |
| --- | --- |
| Claude Code | In `$CLAUDE_CONFIG_DIR/settings.json` (else `~/.claude/settings.json`; managed settings are never written): `permissions.allow` `Bash(workit <verb> *)` per verb and `Bash(workit --version)`; `permissions.ask` `Bash(workit * --unverified*)` and `Bash(workit * --overwrite-unintegrated*)`, so a bypass still asks, in auto mode too; one `autoMode.environment` and one `autoMode.allow` line next to `"$defaults"` and your own; `env.CLAUDE_CODE_SHELL` set to bash when your shell is zsh and nothing is set (`--no-shell` skips it) |
| Codex | `~/.codex/rules/workit.rules` (or under `$CODEX_HOME`), a file Workit owns: one `prefix_rule(pattern=["workit", "<verb>"], decision="allow")` per verb and `["workit", "grant"]` → `prompt`. `config.toml` and its sandbox settings are untouched |
| Cursor | `Shell(workit <verb>)` per verb in `~/.cursor/cli-config.json` `permissions.allow` (cursor-agent matches the rule as a command prefix) |
| OpenCode | Nothing: the Workit plugin's `permission.evaluate` turns an `ask` for a command made only of allowed Workit calls into `allow`. A config `deny` still wins, and `check`, `lock`, `grant`, `--session`, a bypass flag, a redirect or a substitution stay `ask` |
| Pi | Nothing: Pi has no permission layer |

Write the verb first: `workit <verb> --cwd <dir> …`. A host rule cannot match
a variable directory before the verb, so `workit --cwd <dir> git push` would
still prompt; on Claude Code the Workit hook reorders `workit --cwd <dir>
<verb>` and `cd <dir> && workit <verb>` for you. Limits: Codex and Cursor
rules match a prefix, so a bypass flag later in the command
(`workit pr merge --unverified`) is not asked for there (Workit's own grant
and `--reason` still apply), and on Cursor the `workit --session <id> …` form
does not match a rule. Cursor's IDE allowlist (`~/.cursor/permissions.json`)
replaces the whole IDE list, so setup leaves it alone; to use it, add the same
`Shell(workit <verb>)` entries to your existing list yourself.

| Host | Deny | Nudge | Raw commit recorded | Session id in the shell |
| --- | --- | --- | --- | --- |
| Claude Code | PreToolUse | PreToolUse `additionalContext` | PostToolUse | `WORKIT_SESSION_ID` from SessionStart |
| Codex | PreToolUse | PreToolUse `additionalContext` | PostToolUse | `CODEX_THREAD_ID` |
| OpenCode | permission `evaluate` | appended to the shell result | `tool` `execute.after` | `OPENCODE_SESSION_ID` |
| Pi | `tool_call` block | appended to the bash result | `tool_result` | `PI_SESSION_ID` |
| Cursor | `beforeShellExecution` | `agent_message` | on the session's next shell command | none: session context names the id to prefix |

**Skill nudges.** The session contract names a trigger for each skill, but in
a long or compacted session agents act without loading the skill. Inside a
Workit workspace, in a main session (never a subagent):

- A prompt that asks for a skill's work in so many words ("the login test is
  flaky", "let's brainstorm the cache", "babysit it until CI is green") gets
  one advisory line naming the skill and how this host loads it. Single
  common words (plan, build, merge, CI) never trigger it. Claude Code and
  Codex (`UserPromptSubmit`), OpenCode (session context, on a new user
  message) and Pi (`before_agent_start`). Not on Cursor (no per-prompt context
  hook).
- A delivery command (`git push`, `gh pr create|merge`, `glab mr
  create|merge`, `workit pr create|merge`, `workit ci wait`, `workit git
  push`) gets one line naming workit-ship, on every host's shell hook.
- A prompt that relays another agent's words (a subagent hand-back, a
  teammate message, a task notification) is never nudged: only the user's own
  words route.
- Each nudge fires at most once per session, and never once the session
  loaded the skill. A load is recorded as a `skill.loaded` ledger row: Claude
  Code's Skill tool and `/wk-*` commands, OpenCode's skill tool and `/wk-*`
  commands, and a read of the skill's `SKILL.md` (Codex and Cursor shell
  reads, Pi's read tool and `/skill:`). `workit ledger list --type
  skill.loaded` shows which skills sessions used; `/wk-retro` reads it.

**Stop control.** When the main agent ends its turn with an obligation the
ledger or git can prove unmet, the host continues it once with a message
naming the obligation and the workit command that clears it:

- a commit of this session not on the push remote while the workspace's
  effective endpoint (`workit grant show`) is `pr`, `green` or `merged`:
  `workit git push`;
- the branch's open PR with checks recorded failing or pending at its head
  while the endpoint is `green` or `merged`: `workit ci wait --pr <n>`.
  `workit pr status` and each `workit ci wait` poll record the checks summary
  as a `pr.status` ledger row whenever it changes, so the hook never calls
  the forge;
- a PR this session opened (or a delivery it verified) whose head lacks the
  verdict the policy asks for, while the endpoint is `green` or `merged` (a
  PR opens without one, so `pr` never asks): under `verification:
  proportional` the head's review lane decides (none: nothing; self: your own
  `--self` verdict; focused or full: a verifier that did not author it); under
  `verification: self` your own is enough at normal risk; high risk or
  `verification: independent` needs a verifier that did not author it. Not raised while a
  verifier or reviewer this session started is still running.

Each obligation blocks once per head and session, not once per turn.

The continuation's own stop is always allowed, so an agent that cannot finish
says so and stops. A stop is never blocked in a subagent, outside a Workit
workspace, on a protected branch, after a run the user interrupted or that
failed, once the branch landed (`workit pr merge` recorded it, or `workit pr
status`/`ci wait` saw the forge report it merged, even with its remote branch
deleted or merged `--unverified`; with no merge recorded, an upstream that is
gone after a prune counts as landed; a PR closed unmerged does not), or when the agent's last
message asks the user anything: a question mark (also `？`, `؟`, `¿`), an
offer such as "want me to" or "let me know", or a `[y/N]` prompt, in its last
paragraphs. Another session's commits never count. The check reads the
ledger and local git only, never the forge, and any failure allows the stop.

| Host | Event | Continue | One per turn |
| --- | --- | --- | --- |
| Claude Code | `Stop` | `{"decision":"block","reason"}` | `stop_hook_active` |
| Codex | `Stop` | `{"decision":"block","reason"}` | `stop_hook_active` |
| Cursor | `stop` | `{"followup_message"}` (last message read from `transcript_path`) | `loop_count`, `loop_limit: 1` |
| Pi | `agent_end` | `pi.sendMessage(…, {triggerTurn: true})` | the extension skips the next `agent_end` |
| OpenCode | `session.idle` event | `session.synthetic({resume: true})` | the plugin skips the next idle |

**Implementer worktrees.** The `workit:implementer` agent runs without Claude
Code's worktree isolation, which refuses any command it cannot verify and any
command that wraps git (`workit git …`, `workit check`) and cannot be turned
off. The lead makes the worktree first with `workit fanout worktree create
<slice>` (on every host), which also links the main checkout's
`node_modules` so the worktree's tests import its own workspace packages. The
implementer works there with `workit --cwd <worktree> git|check …`, one verb
per call. Workit's pre-tool hooks bind it to the first Workit worktree it
changes and deny its edits and mutating git commands outside that worktree,
naming it; before that, a change outside every Workit worktree is denied, so
it never edits the lead's checkout. Worktree, ref, config and fan-out plan
changes stay the lead's and are denied to the implementer. An agent still running in a
`.claude/worktrees/` checkout (spawned with `isolation: "worktree"`) is told
up front to run git as plain separate commands there (`git switch -c`,
`git commit --trailer "Workit-Session=<session>"`, `git push`) and workit for
the non-git verbs.

`workit` reads `WORKIT_SESSION_ID` first (set it, even empty, to override),
then the host's own variable from the table. Cursor puts no conversation id in
the agent's shell (its `sessionStart` env reaches hooks only), so its session
context says `workit --session <id> git commit …` (the global `--session`
flag goes before the command and beats `WORKIT_SESSION_ID`; the commit nudge
still shows `WORKIT_SESSION_ID=<id> workit git commit …`).
Cursor's raw commits are recorded when the session runs its next shell command
in the same checkout, since no post-shell hook is registered yet. A
`WORKIT_SESSION_ID` inherited from another host (its `WORKIT_HOST` names that
host, as when Codex runs inside Claude Code's Bash) yields to the inner host's
own id; to assign a verifier id there, set `WORKIT_HOST` to the inner host too.
The `prepare-commit-msg` hook that `workit doctor --fix` installs resolves the
session the same way, so plain `git commit`s on every host carry the trailer
(Cursor only with `WORKIT_SESSION_ID` set); see
[the session trailer hook](delivery.md#session-trailer-hook).

## OpenCode

Requires OpenCode 2.0.18+ and Node.js 24+.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@brainervirus/workit-opencode"]
}
```

A checkout pin uses `"file:///path/to/workit/packages/workit-opencode"` after
`bun packages/workit-opencode/scripts/build.ts`. Never pin into pnpm dlx or
`_npx` cache paths.

The plugin (V2 `setup()` API, self-contained bundle) registers nine tools: the
seven task families, read-only `workit_context`, and `workit_init_apply`. It
adds the eleven skills with `wk-*` commands (an existing user skill with the
same id wins), direct-child subagent delegation, and context injection on
session start and after compaction. Its shell hook denies direct, unquoted
literal branch-creation commands that break the workspace naming policy and
the raw git/forge gate bypasses above.

**OpenCode 1.x** can only load the removed V1 entry. Stay on Workit 2.x there:
`{ "plugin": ["@brainervirus/workit-opencode@2"] }`. `workit doctor` fails
`opencode_version` on a 1.x CLI.

## Cursor

Select Cursor in `workit init`: it registers the plugin (copied as a real
directory into `~/.cursor/plugins/local/workit`), MCP server, session hook,
the `workit-contract` rule and the skills. Manual MCP config:

```json
{
  "mcpServers": {
    "workit": {
      "command": "npx",
      "args": [
        "-y",
        "--prefer-online",
        "--min-release-age=0",
        "--package=@brainervirus/workit-cursor@latest",
        "workit-cursor-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

`@latest`, `--prefer-online` and `--min-release-age=0` are intentional: the
runtime resolves from npm at launch (the age override works around
npm/cli#9765). First run needs network access.

Hooks do not use npm at launch. Each one runs the plugin's launcher
(`hooks/launch.mjs`), which prefers the bundled hook that `workit init`
installs, then a global `workit-cursor-hook`, then `npx --prefer-offline`
pinned to the plugin's version. Hooks fail open: when the runtime cannot run
(offline, crash, timeout) the action proceeds without Workit checks; Workit
denials still block. `workit init` writes the launcher's absolute path into
every hook. `workit doctor` shows the launcher mode and latency, and warns
when Cursor sessions started but no Workit hook has run since.

Limits: AskQuestion is policy-only, session start and compaction are
non-blocking, arbitrary shell writes and Tab edits are not observable, and
subagent stop identity is unstable, so native delegation is read-only. MCP is
read-only for unattested callers; mutations run through
`node_modules/.bin/workit <family> <action> --json`.

## Codex CLI / desktop

```bash
codex plugin marketplace add https://github.com/BrainerVirus/workit.git
codex plugin add workit@workflow-toolkit
```

The plugin bundles documented lifecycle hooks and the shared MCP server.
Reads run over MCP; mutations run through the CLI. Codex has no slash
aliases: use `$workit-<name>` or the `/skills` picker. Native Codex
permission and sandbox settings stay authoritative.

The hooks give Codex the session contract (`SessionStart`, also after
compaction), the task context on each prompt when it changed since the last
injection plus the skill nudge (`UserPromptSubmit`), the before-write gate on
`apply_patch` and branch/raw-git steering (`PreToolUse`), raw-commit recording
(`PostToolUse`), and subagent guidance (`SubagentStart`). A custom agent named
`workit-verifier` or `workit-reviewer` is told its own Workit session id for
`workit ledger verdict --session`; one named `workit-implementer` is told to
work only in its own worktree (`workit fanout worktree create <slice>`) on a
policy-compliant branch, and Workit's `PreToolUse` hook denies its changes
outside that worktree when Codex names the agent on the tool call.

The plugin ships those three agents. Codex plugins cannot register agents, so
the plugin's MCP server copies `workit-verifier.toml`, `workit-reviewer.toml`
and `workit-implementer.toml` into `~/.codex/agents/` (the Codex home that
installed the plugin) each time it starts; Codex offers them from the next
session. Their instructions come from the same source as the Claude Code
agents. The verifier and reviewer run in a read-only sandbox, so they ask you
to approve `workit check` and `workit ledger verdict`; the implementer never
records a verdict. A file of the same name that you wrote yourself is never
overwritten, nor is a symlink, nor a copy written by a newer plugin version
(each copy's first line names the plugin version that wrote it).

Codex runs plugin hooks only after you trust them: run `/hooks` in Codex, or
pick "Trust all and continue" when Codex asks you to review hooks at startup.
Trust them there, not by editing `config.toml` by hand: Codex's review shows
what each hook runs, and a hand-added trust entry that duplicates one Codex
already wrote breaks `config.toml`. `workit doctor` checks both:

- `codex_hooks` warns when a workit hook is untrusted, changed since you
  trusted it, or disabled, and names the hooks. The fix is `/hooks` (or the
  startup "Trust all and continue").
- `codex_agents` warns when the agents are missing or outdated in
  `~/.codex/agents/`, or when one of them is a symlink. The fix is
  `node "<plugin root>/dist/launch-mcp.js" --install-agents`, then a new
  Codex session. A plugin too old to bundle agents gets
  `codex plugin remove workit@<marketplace> && codex plugin add workit@<marketplace>`.
- `hook_issued_sessions` (Codex and Claude Code) warns when the plugin hook
  is older than the CLI. Such a hook records no SubagentStart session ids, so
  `workit ledger verdict --session <lead>:<agent id>` is refused. The fix is
  to update the plugin, then relaunch the verifier.

## Pi

```bash
pi install npm:@brainervirus/workit-pi
pi install ./packages/workit-pi -l --approve   # local checkout
```

Pi 0.85.1 loads the extension and skills from the package's `pi` manifest. The
extension uses Pi's native session identity, exposes the seven families plus
read-only `workit_context`, and bundles a coordinator that launches fresh
reviewer/investigator processes and scoped implementers. Pi project trust
still gates mutations; shell writes are agent-guided (an extension is not an
OS sandbox).

`workit doctor` checks the extension (`pi_extension`) when Pi is installed. It
reads the `packages` in `~/.pi/agent/settings.json` and `.pi/settings.json`
(the project entry wins) and warns:

- missing: no `@brainervirus/workit-pi` entry, or one Pi has not installed.
  Fix: `pi install npm:@brainervirus/workit-pi` (add `-l` for a project
  entry).
- not loading: the entry's `extensions` filter drops `dist/workit.js`, or the
  package has no built `dist/workit.js`. Fix: remove the filter (or enable the
  extension in `pi config`), or reinstall the package; a local checkout gets
  `cd <checkout> && bun run build`.
- stale: the package is older than the workit CLI and a newer one is
  published. Fix: `pi update npm:@brainervirus/workit-pi`, or
  `pi install npm:@brainervirus/workit-pi@<version>` for a pinned entry. When
  the registry is unreachable, or the entry is a local checkout, an older
  package passes and the detail says it was not compared.

## Read-only context

Every host can read `git`, `pr`, `youtrack`, `github_issue`, `gitlab_issue`,
`changelog`, `release` and `affected` context without approval: OpenCode via
`workit_context`, Pi and the CLI via `context.read`, Cursor and Codex as MCP
resources `workit://context/{kind}`. Tracker reads use your authenticated
`gh`/`glab`.
