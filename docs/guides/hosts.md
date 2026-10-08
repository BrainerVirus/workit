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
and bash) and Claude Code. Codex's PreToolUse does not see `apply_patch`, so
there the gate is advisory and the session context says so.

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
and never grant permission: host allow/deny rules stay authoritative.

| Host | Deny | Nudge | Raw commit recorded | Session id in the shell |
| --- | --- | --- | --- | --- |
| Claude Code | PreToolUse | PreToolUse `additionalContext` | PostToolUse | `WORKIT_SESSION_ID` from SessionStart |
| Codex | PreToolUse | PreToolUse `additionalContext` | PostToolUse | `CODEX_THREAD_ID` |
| OpenCode | permission `evaluate` | appended to the shell result | `tool` `execute.after` | `OPENCODE_SESSION_ID` |
| Pi | `tool_call` block | appended to the bash result | `tool_result` | `PI_SESSION_ID` |
| Cursor | `beforeShellExecution` | `agent_message` | on the session's next shell command | none: session context names the id to prefix |

`workit` reads `WORKIT_SESSION_ID` first (set it, even empty, to override),
then the host's own variable from the table. Cursor puts no conversation id in
the agent's shell (its `sessionStart` env reaches hooks only), so its session
context and commit nudge say `WORKIT_SESSION_ID=<id> workit git commit …`.
Cursor's raw commits are recorded when the session runs its next shell command
in the same checkout, since no post-shell hook is registered yet. A
`WORKIT_SESSION_ID` inherited from another host (its `WORKIT_HOST` names that
host, as when Codex runs inside Claude Code's Bash) yields to the inner host's
own id; to assign a verifier id there, set `WORKIT_HOST` to the inner host too.

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

## Read-only context

Every host can read `git`, `pr`, `youtrack`, `github_issue`, `gitlab_issue`,
`changelog`, `release` and `affected` context without approval: OpenCode via
`workit_context`, Pi and the CLI via `context.read`, Cursor and Codex as MCP
resources `workit://context/{kind}`. Tracker reads use your authenticated
`gh`/`glab`.
