# Troubleshooting

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
