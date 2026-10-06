# Claude Code

Workit ships as a native Claude Code plugin: hooks, the eleven method skills
(`/workit:<name>`), three agents, and `workit` on the Bash tool's `PATH`. No MCP
server is registered: Claude has a shell, and tool schemas cost context. To
opt in anyway, add `workit-mcp` to your own Claude settings.

## Install

**Published.** The repository root is a Claude Code marketplace
(`.claude-plugin/marketplace.json`) whose entry installs the
`@brainervirus/workit-claude-code` npm package. Node.js 24+ is required.

```bash
claude plugin marketplace add BrainerVirus/workit
claude plugin install workit@workit
claude plugin marketplace update workit && claude plugin update workit@workit   # update
```

`workit init` can do this for you. `workit doctor` warns (`claude_plugin`) when
a newer version is published. `workit uninstall` runs the native
`claude plugin uninstall` for each install that applies where you run it.

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
| `PreToolUse` on `Bash`/`PowerShell` `git *` | Denies protected or non-compliant branch operations with `permissionDecision: "deny"` and an unblock hint; never answers `allow`, so your permission prompts stay in charge |
| `SubagentStart` | Tells the `implementer` it works in its own worktree; tells other subagents they are read-only |

Hooks fail open: if the runtime cannot start (no Bun for a pin, missing
`dist/`), the hook answers nothing, prints one
`[workit] Claude Code hook unavailable: …` line, and Claude runs as if Workit
were not installed. `PreCompact` cannot inject context, so context is restored
by `SessionStart` with `source: "compact"`.

## Agents

| Agent | Role |
| --- | --- |
| `verifier` | Read-only. Runs the brief's checks through `workit check` and records a `workit ledger verdict` under its own session |
| `reviewer` | Read-only. Reviews intent fidelity, standards, test quality and blast radius; records a review verdict |
| `implementer` | `isolation: worktree`. Edits and commits in its own worktree on a policy-compliant branch |

The SubagentStart hook gives each verifier/reviewer its own session id, so the
ledger never accepts the author's verdict on its own work.
