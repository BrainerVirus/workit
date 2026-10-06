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
session start and after compaction. Its shell hook denies only direct,
unquoted literal branch-creation commands that break the workspace naming
policy.

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
