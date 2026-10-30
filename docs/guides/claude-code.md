# Claude Code

Workit ships as a native Claude Code plugin: hooks, the thirteen method skills
(`/workit:<name>`), three agents, and `workit` on the Bash tool's `PATH`. No MCP
server is registered: Claude has a shell, and tool schemas cost context. To
opt in anyway, add `workit-mcp` to your own Claude settings.

## Install

**Published.** The repository root is a Claude Code marketplace
(`.claude-plugin/marketplace.json`) whose entry installs the
`@brainervirus/workit-claude-code` npm package. Node.js 24+ is required. If the `node` on `PATH` is older (a repo pinned by
fnm, nvm or volta), the hooks and the `workit` shim look for a Node 24+ in this
order: `WORKIT_NODE`, the Node `workit setup` or `workit upgrade` recorded, then
fnm, nvm, volta, mise and asdf installs. With none found the hooks are off
(SessionStart says so once) and verdicts fail with `no_session`; `workit doctor`
row `hook_node` names the cause. Fix it by installing Node 24 or running
`workit setup` from a Node 24 shell.

```bash
claude plugin marketplace add BrainerVirus/workit
claude plugin install workit@workit
```

`workit init` can do this for you. Update with `workit upgrade` (native
fallback: `claude plugin marketplace update workit && claude plugin update
workit@workit`), then restart Claude Code ([updates](hosts.md#claude-code)).
`workit doctor` warns (`claude_plugin`) when a newer version is published. `workit uninstall` runs the native
`claude plugin uninstall` for each install that applies where you run it.

**Permissions.** A plugin cannot ship permission rules, and in auto mode the
classifier cannot see Workit's grants or verdicts, so it may deny `workit pr
merge` as "Merge Without Review". Run `workit setup --hosts=claude-code` in
your own terminal (not from a Claude Code session: it refuses there): after
showing the diff it adds enumerated `Bash(workit <verb> *)` allows, `ask`
rules for `--unverified` and `--overwrite-unintegrated` (the Workit hook also
asks for them however they are quoted), one
`autoMode.environment` and one `autoMode.allow` line describing Workit's
gates, and `env.CLAUDE_CODE_SHELL` (bash) when your shell is zsh. See
[the hosts guide](hosts.md#host-permissions-workit-setup).

**Local pin to a checkout.** Hooks and `bin/workit` run the TypeScript sources
with Bun, so edits apply without rebuilding. Only the skills are generated:

```bash
bun install
bun packages/workit-claude-code/scripts/build.ts --skills-only
claude --plugin-dir "$PWD/packages/workit-claude-code"          # one session
export CLAUDE_CODE_PLUGIN_DIRS="$HOME/path/to/workit/packages/workit-claude-code"   # every session
```

Disable the marketplace copy while pinned (`claude plugin disable
workit@workit`) so both do not load. `WORKIT_CLAUDE_RUNTIME=source|dist`
forces one runtime; `WORKIT_SHIM_TRACE=1 workit …` prints which entry ran.

## What it registers

| Event | Behavior |
| --- | --- |
| `SessionStart` (startup, resume, clear, compact, fork) | Injects the Workit contract and the branch's task context; exports `WORKIT_HOST` and `WORKIT_SESSION_ID` to the session shell |
| `UserPromptSubmit` | Re-injects task context only when it changed |
| `PreToolUse` on `Bash`/`PowerShell` and `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | Denies protected or non-compliant branch operations, and working-tree edits while the branch task has an open product choice or needs a plan (the before-write gate), and in a Workit workspace raw gate bypasses (`gh pr merge`, `glab mr merge`, a push onto a protected branch), with `permissionDecision: "deny"` and the unblock. Routine raw `git commit`/`git push`/`gh pr create` get an `additionalContext` nudge toward the workit verb ([hosts](hosts.md)). Never answers `allow`, so your permission prompts stay in charge. Plain shell commands, and edits in a checkout without Workit tasks, are answered before the runtime loads; so is a PostToolUse whose command has no `commit` |
| `PostToolUse` on `Bash`/`PowerShell` | Records a raw `git commit` that moved HEAD (noted by PreToolUse) as the session's `commit.recorded` ledger row, so its own verdict is not independent |
| `SubagentStart` | Tells the `implementer` it works only in the worktree its lead made with `workit fanout worktree create`, through `workit <verb> --cwd <worktree> …`; tells other subagents they are read-only |

Hooks fail open: if the runtime cannot start (no Bun for a pin, missing
`dist/`), the hook answers nothing, prints one
`[workit] Claude Code hook unavailable: …` line, and Claude runs as if Workit
were not installed. `PreCompact` cannot inject context, so context is restored
by `SessionStart` with `source: "compact"`.

Hooks also answer before Claude Code's timeout. Prompt, tool and subagent hooks
get 15 seconds, and `SessionStart` and `Stop` get 20. Normally a hook takes
well under a second. On an overloaded machine it can take several seconds, and
Claude Code discards the output of a hook it times out. So each hook has its own
deadline, counted from the start of its process: 8 seconds, or 16 for
`SessionStart` and `Stop`. A hook past that
deadline answers `workit context skipped: host under load` instead of its usual
context, and that turn gets no gates or nudges. `workit doctor` counts these
skips over the last day in its `hook_deadline` row. To change the deadline, set
`WORKIT_HOOK_DEADLINE_MS`.

## Agents

| Agent | Role |
| --- | --- |
| `verifier` | Read-only. Runs the brief's checks through `workit check` and records a `workit ledger verdict` under its own session |
| `reviewer` | Read-only. Reviews intent fidelity, standards, test quality and blast radius; records a review verdict |
| `implementer` | No `isolation` (Claude Code's refused every wrapped git). Edits and commits only in the worktree the lead made with `workit fanout worktree create <slice>`, running `workit git\|check --cwd <worktree> …` one verb per call; the `PreToolUse` hook denies its edits and mutating git commands outside that worktree |

The SubagentStart hook gives each verifier/reviewer its own session id, so the
ledger never accepts the author's verdict on its own work.
