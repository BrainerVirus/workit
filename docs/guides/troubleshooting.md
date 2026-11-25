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
| A partly staged file shows only its staged hunks after a `workit git commit` was killed | `unstaged_backups` | The rest is kept under the git dir's `workit/unstaged-*`: `workit gc --unstaged` lists it, `--apply` puts back each file nobody edited since; an edited file is never overwritten, so copy it back from the folder by hand |
| Store grows large | none | `workit gc --dry-run`, then `workit gc` |
| `recovery` copies from 2.x reported | none | `workit gc --prune-recovery --yes` |
| A hook prints `[workit] <host> hook unavailable` | `hook_node`, `hook_runs` | The hook failed open: see [Workit hooks are off](#workit-hooks-are-off) (a Node 24+ for the hooks, or `workit upgrade` and a host restart) |
| Claude Code plugin missing or not loaded | `claude_plugin`, `claude_session_plugin` | `workit upgrade` and restart Claude Code; a local pin needs Bun |
| Codex hooks do not run | `codex_hooks` | Trust them with `/hooks` in Codex |
| Codex verifier or reviewer agents missing | `codex_agents` | `workit upgrade`, then a new Codex session |
| A host row in `workit upgrade` reads `FAILED` | none | The row names the command, its exit code and its last output lines; see [A host step failed during upgrade](#a-host-step-failed-during-upgrade) |
| OpenCode fails `opencode_version` | `opencode_version` | Upgrade OpenCode to 2.0.18+ |
| Pi does not load Workit | `pi_extension` | See [Pi](hosts.md#pi) |
| An agent could edit a Workit-guarded file (`workspaces.json` and its seal, approvals, issued sessions) | `native_deny` | `workit setup` in your own terminal writes each host's own deny rules (Claude Code, Cursor, OpenCode) |
| A heavy check waits with no holder named, or names "memory pressure" | `pressure_gate`, `heavy_scope` | The machine is over its pressure line; `workit lock status` shows the budget. A failing `heavy_scope` names the systemd `Delegate` fix. See [checks](checks.md) |
| `youtrack.writes: auto` posts to any YouTrack | `youtrack_writes` | Name the allowed hosts in `youtrack.autoHosts` ([YouTrack guide](youtrack.md)) |
| A `.workit` folder appeared outside a repository | `stray_workit` | Any Workit command there moves it into the state dir once; see [A `.workit` folder outside a repository](#a-workit-folder-outside-a-repository) |
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

## A host step failed during upgrade

A `FAILED` row in the `workit upgrade` result names the command that failed,
how it ended (`exit <code>` or `timed out`) and the last lines it printed on
stderr and stdout, with tokens and passwords redacted. The `fix:` line under
it is the one command to rerun that host, such as `workit upgrade --hosts=codex`.

`codex plugin marketplace upgrade workit` fetches the marketplace with git and
can fail for a moment. The upgrade retries it once after a two-second pause
before the row fails. When a host step still fails, the steps that need it
(`codex plugin add workit@workit` after the marketplace) are listed under the
row as skipped. The steps that do not need it still run: Workit installs the
Codex role agents from the newest cached plugin, and the row says whether that
worked or why it was skipped.

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

## A `.workit` folder outside a repository

Outside a git repository Workit keeps a folder's ledger, tasks, plans, retros,
handoffs and notes in its state dir, `<state>/folders/<folder>-<hash>`
(`workit dir notes` prints a path there), never in the folder. Older Workit
wrote them into `<folder>/.workit`, so a multi-repo parent, a home folder or a
synced folder could collect one.

The first Workit command in that folder moves it and prints one line:

```text
workit: moved /work/.workit to ~/.local/state/workit/folders/work-1a2b3c4d5e6f (outside a git repository Workit keeps its state there)
```

`checks.json` and `risk-paths` stay where they are. When the state dir already
holds an entry by the same name, Workit keeps both and leaves
`.workit/MOVED-TO-STATE.txt` with the `cp -Rn` command that merges the rest; delete
the old copies once merged.

`workit doctor` reports such a folder in the current directory or any parent
as `stray_workit`, with the command that moves it (`workit --cwd <folder> dir
notes`). The [file locations](../agents/file-locations.md#a-workit-outside-git)
reference has the details.
