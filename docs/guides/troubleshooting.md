# Troubleshooting

Run `workit doctor` (or `--json`) first: each row names its check id and its repair. The table
maps common symptoms to those ids.

| Symptom | Doctor check | Fix |
| --- | --- | --- |
| Something is off after install or upgrade | `versions`, `stale_install`, `stale_pin` | `workit upgrade`; each finding names its repair |
| Hook says "workit migration pending" | none | Run `workit task status` once in that checkout; hooks never migrate |
| A command returns `busy` (exit 4) | `workspace_lock` | Another workit process holds the store or stack lock; retry. A dead holder is reclaimed automatically; `workit doctor --fix-lock` clears a stale one. For the heavy-check lease, `workit lock status` names the holder |
| `blocked` (exit 3) on push/PR/merge | `grant_endpoint`, `grant_seal`, `github_identity`, `gitlab_identity` | Read `unblock` in the output: usually a missing grant (`workit grant show`), an unsealed change (`workit workspace seal` in your own terminal) or a `gh`/`glab` login that is not the workspace account |
| Agents get permission prompts for `workit` verbs | `claude_permissions`, `codex_permissions`, `cursor_permissions`, `*_grant_rules` | `workit setup` in your own terminal |
| Hook answers "workit context skipped: host under load" | `hook_deadline` | Rare under normal load; see the [Claude Code guide](claude-code.md) for `WORKIT_HOOK_DEADLINE_MS` |
| Store grows large | none | `workit gc --dry-run`, then `workit gc` |
| `recovery` copies from 2.x reported | none | `workit gc --prune-recovery --yes` |
| Claude Code hook prints `[workit] Claude Code hook unavailable` | `claude_plugin`, `claude_session_plugin` | The hook failed open: install Bun for a local pin, or `workit upgrade` and restart Claude Code |
| Codex hooks do not run | `codex_hooks` | Trust them with `/hooks` in Codex |
| Codex verifier or reviewer agents missing | `codex_agents` | `workit upgrade`, then a new Codex session |
| OpenCode fails `opencode_version` | `opencode_version` | Upgrade OpenCode to 2.0.18+ |
| Pi does not load Workit | `pi_extension` | See [Pi](hosts.md#pi) |
| An agent could edit a Workit-guarded file (`workspaces.json` and its seal, approvals, issued sessions) | `native_deny` | `workit setup` in your own terminal writes each host's own deny rules (Claude Code, Cursor, OpenCode) |
| `youtrack.writes: auto` posts to any YouTrack | `youtrack_writes` | Name the allowed hosts in `youtrack.autoHosts` ([YouTrack guide](youtrack.md)) |
| Agents do not know ytrack's commands | `ytrack_skill` | The fix doctor names: `ytrack skill install`, `ytrack skill sync` or `ytrack upgrade` (ytrack 0.6.0+ keeps its own skill) |

## "Workit hooks are off"

Claude Code, Codex and Cursor start Workit's hooks with the `node` the repo
resolves. When a hook cannot run (a Node below 24 with no Node 24+ to re-run
on, a bundle that throws on import, a missing runtime, a crash), it never
blocks the host: it answers as if Workit were not installed. It does not stay
quiet either:

| Host        | What you and the agent see                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Claude Code | A `systemMessage` warning and agent context on `SessionStart`, every `UserPromptSubmit` and `SubagentStart`   |
| Codex       | The same `systemMessage` and `additionalContext` on `SessionStart`, `UserPromptSubmit` and `SubagentStart`    |
| Cursor      | `additional_context` on `sessionStart`                                                                         |

Every event also writes one `[workit] <host> hook unavailable: <cause>` line on
stderr and counts a failure row in `<state dir>/hook-runs/<host>__<event>__failed.json`.

While the hooks are off there is no branch policy, no task context and no
verifier or reviewer session: a verdict recorded by a subagent fails with
`no_session`. To fix it:

```bash
workit doctor   # run it in the repo the host works in
```

- `hook_node` runs each installed hook launcher once, with the `node` this
  directory resolves, and fails when one does not answer. Its detail names the
  launcher and the cause.
- `hook_runs` warns when a host's newest hook record is a failure.

For `needs Node >=24, found 22.x`, install Node 24 (`fnm install 24`,
`nvm install 24`) or run `workit setup` from a Node 24 shell so Workit records
it; `WORKIT_NODE=/path/to/node24` also works. For a bundle that cannot load,
run `workit upgrade` and restart the host. Then run `workit doctor` again and
spawn a fresh verifier or reviewer.

OpenCode and Pi load Workit in-process as a plugin or extension. A load error
there is the host's own plugin error; `workit doctor` checks them with
`opencode_version` and `pi_extension`.

## OpenCode stays one Workit version behind

`workit doctor` reports `stale_install` when OpenCode's Workit plugin is older
than the version on npm. Run `workit upgrade`: it waits for OpenCode to load
its plugins, then updates the plugin.

A release can reach npm a few minutes after the CLI it ships with. An upgrade
that runs in that window installs the previous OpenCode plugin. Its result row
then says that the newer version appeared after the run read the registry. Run
`workit upgrade` again.

To update by hand, run `opencode plugin update @workit-dev/opencode` from your
home directory. OpenCode loads plugins separately for each directory, in the
background. In a directory it has not used before, the first call can answer
`Plugin is not configured`. Run the same command a second time.
