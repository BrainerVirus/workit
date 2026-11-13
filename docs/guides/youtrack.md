# YouTrack issues

Workit reads and writes YouTrack through its own verbs, and those verbs run
[`ytrack`](https://github.com/BrainerVirus/youtrack-cli). ytrack is required:
Workit never reads, writes, prompts for or stores a YouTrack token, and an
agent never calls the YouTrack API by hand.

```sh
workit youtrack show ABC-123 --json
workit youtrack create --project ABC --summary "Crash on start" --file notes.md
workit youtrack note ABC-123 --markdown "Fixed in #42" --minutes 30
workit youtrack time ABC-123 --minutes 45 --text "Code review"
workit youtrack meeting ABC-123 --minutes 30 --text "Planning"
workit youtrack update ABC-123 --file notes.md --attach shot.png --minutes 45 --state Done
```

## Set up ytrack

1. Install ytrack from
   [BrainerVirus/youtrack-cli](https://github.com/BrainerVirus/youtrack-cli):
   `install.sh` on Linux and macOS, `install.ps1` on Windows.
2. Log in once to your instance: `ytrack auth login --host <host>`, for
   example `ytrack auth login --host acme.youtrack.cloud`. ytrack keeps the
   token in the OS keyring.

`youtrack.json` keeps the rest of the setup (`baseUrl`, `meetingIssue`,
`timezone`, and so on). Workit passes `baseUrl` to ytrack as `YTRACK_HOST`, so
both talk to the same instance, and never passes a token. `workit setup` and
the OpenCode init action write `youtrack.json` without a token and check ytrack
instead: when it is missing they name the install, and when it is not logged in
to the configured host they name `ytrack auth login --host <host>`.

An older Workit wrote `youtrack.token` next to `youtrack.json`. Workit no
longer reads it; delete it once ytrack is logged in.

`workit doctor` shows a `youtrack` row whenever `youtrack.json` exists, a
workspace links YouTrack issues, or a legacy `youtrack.token` is left. It runs
`ytrack auth status` and passes when ytrack is logged in to every configured
host. It warns when ytrack is missing (the fix names the install), when ytrack
is logged out of a host (the fix is `ytrack auth login --host <host>`), and
when a legacy `youtrack.token` still exists (the fix is to delete it; doctor
only checks that the file exists).

## The ytrack skill for agents

A ytrack newer than 0.2.1 carries an agent skill that teaches coding agents its
commands, stamped with the ytrack version that installed it. When YouTrack is
in use (`youtrack.json` exists, or a workspace tracks issues in YouTrack),
`workit init` (when you pick YouTrack), `workit setup` and `workit upgrade`
install that skill for every host that has Workit, by running
`ytrack skill install --dir <skills dir> --json` into the host's own skills
directory. The `workit init` finish screen lists the result after the doctor
lines, for example:

```text
ytrack skill 0.3.0 installed for claude-code, pi
  ~/.claude/skills/ytrack
  ~/.pi/agent/skills/ytrack
```

The skills directory for each host:

| Host | Skills directory |
| --- | --- |
| Claude Code | `~/.claude/skills` (`$CLAUDE_CONFIG_DIR/skills`) |
| Codex | `~/.codex/skills` (`$CODEX_HOME/skills`) |
| Cursor | `~/.cursor/skills` |
| OpenCode | `~/.config/opencode/skills` (`$XDG_CONFIG_HOME/opencode/skills`) |
| Pi | `~/.pi/agent/skills` (`$PI_CODING_AGENT_DIR/skills`) |

A skill that is already at the installed ytrack's version is left alone. After
`ytrack upgrade`, run `workit upgrade` to bring every host's skill to the new
version. Agents use `workit youtrack …` for issue work, and the `ytrack` skill
for anything those verbs do not cover.

- An older ytrack without `ytrack skill` installs nothing: the init, setup or
  upgrade output and `workit doctor` say to run `ytrack upgrade`.
- A `ytrack` directory there that holds some other skill is left untouched; the
  row names the `ytrack skill install --dir <dir>` command to run once you have
  moved it.
- Workit records the skill directories it created, and `workit uninstall`
  removes exactly those. A ytrack skill you installed yourself stays.

`workit doctor` shows a `ytrack_skill` row when YouTrack is in use and ytrack
is on `PATH`. It passes when every host's `SKILL.md` has the version
`ytrack version` prints, and warns when one is older or missing, with
`workit upgrade --hosts=<host>` as the fix.

## Reading an issue

`workit youtrack show <ISSUE>` prints the issue's summary, state, URL, custom
fields and comments. With `--json` the data is:

```json
{
  "issueId": "ABC-123",
  "summary": "Crash on start",
  "description": "Steps …",
  "state": "Open",
  "url": "https://acme.youtrack.cloud/issue/ABC-123",
  "fields": [{ "name": "Assignee", "value": "jdoe" }],
  "comments": [{ "id": "4-1", "text": "Reproduced", "author": "jroe", "created": "2026-10-01T10:00:00Z" }],
  "source": "ytrack"
}
```

A field value is one plain value: an enum's name, a user's login, a period's
text, or a list of those. Deleted comments are left out. Reading needs no
write flag.

## Creating an issue

`workit youtrack create --project <P> --summary <s>` creates an issue in the
project with that short name or name, and prints its id and URL. The
description comes from `--description <text>` or `--file <path>`.
`--attach <file>` (repeatable) attaches files to the new issue and
`--command '<command>'` applies a YouTrack command to it, under the same one
yes. When a later part fails, the issue still exists: finish it with
`workit youtrack update <id>`, never create it again.

## Updating an issue in one go

`workit youtrack update <ISSUE>` makes a whole issue update under one yes:

```sh
workit youtrack update ABC-123 --file notes.md --attach shot.png --attach report.html \
  --minutes 165 --state Done
```

- `--markdown <text>` or `--file <path>`: one comment.
- `--attach <file>` (repeatable): files on that comment. A file the comment
  names as `![](shot.png)` shows inline in it; the others sit alongside it.
  Without a comment the files are attached to the issue itself. Two files
  with the same name are refused (ytrack keeps files by name).
- `--minutes <n>`, with `--text` and `--date` as for `time` (either one needs `--minutes`): a work item.
- `--state <S>` (the command `State <S>`) and `--command '<command>'`.

Pass at least one. Before asking, Workit checks that each file exists and that
your ytrack supports `--attach` (an older one fails with `ytrack upgrade` as
the fix); nothing is asked or posted until both hold. The request you approve
lists every part on that issue and host: the whole comment (a long one ends
with "N more lines"), each file's name, size and content hash, the time (`2h45m`) and the state or command. After your
yes the parts run in order (comment, time, then commands) and the result lists
each one. The run stops at the first failure and says what landed and what
was not applied; rerunning skips a comment or time that landed (its marker),
but a command or a file-only attach has no marker, so check the issue first.

## Writes ask you first

Every write (`create`, `note`, `time`, `meeting`, `update`) waits for your yes, in every
workspace. How you give it depends on the host (#864):

| Host | How you approve |
| --- | --- |
| Claude Code (also in auto mode) | The permission prompt on the `workit youtrack …` call itself shows the full text; Yes posts it in that call, once. No id, no second command. In `bypassPermissions`, `dontAsk` or `claude -p` nobody sees a prompt, so nothing is approved and the call names the mode. |
| Pi (TUI) | A dialog on the call shows the full text; Approve once posts it in that call. |
| OpenCode, Codex, Cursor, Pi print/RPC | The call records one request for that text and refuses with `approval_needed`. You run `workit approve` in a terminal: it shows the full text and asks y/N (with an id only when several requests wait). The agent's next run uses your yes once. |

A changed text or length needs a new yes. Refusing the same text again reuses
its request: one text, one id. The agent must run the call as its own plain
command (no pipe, chain, redirect, `bash -c` or variable around it), or the
host cannot show it to you; a wrapped call is denied with the plain form. See
[Approvals](approvals.md) for the other approvals.

Before asking, Workit reads the issue back:

- A comment or work item carries a marker, so a retry of a write that landed
  reports `already_done` and posts nothing.
- A comment, or a work item with the same text, minutes and day, that you
  already have on the issue is refused with `duplicate_entry` and its id.
- A call that was interrupted or lost its reply is settled by the next
  `note`, `time` or `meeting` call, which reports whether it landed
  (`earlier` in `--json`).

A PR backlink (`issues.backlink: true`) asks the same way: `workit pr create`
reports it `pending` with the request to approve, and the next
`workit pr create` or `workit pr edit` of that PR posts it once.

An agent that runs a `ytrack` write itself (`ytrack issue comment`,
`ytrack work-item add`, `ytrack issue create|edit|delete|command|attach`, or
`ytrack api` with POST, PUT, PATCH or DELETE), plain or wrapped in `bash -c`,
a chain, a pipe, `npx` or a full path, is stopped by Workit's shell hook. When
a `workit youtrack` verb does the same thing, the hook names that exact call,
which asks you first. A time log (`ytrack work-item add`) is named as its
`workit youtrack time` call even when the agent's command was not plain (a
leading `cd`, a loop, `bash -c`). Several writes on one issue chained with `&&` or `;`
(a comment with `--attach`, `ytrack issue attach`, `ytrack work-item add`,
`ytrack issue command`, or a hand-built `ytrack api` POST to the issue's
`comments` or `attachments`) are named as one `workit youtrack update` call,
so you answer one ask for the whole update. For a write no verb covers:

| Host | What happens |
| --- | --- |
| Claude Code | The permission prompt on the call: you decide it there. |
| Codex, Cursor, Pi, OpenCode | The call is refused; the agent asks you, and you run the command in a terminal if you agree. |

Reads (`ytrack issue view`, `ytrack work-item list`, `ytrack api` GET) are
never stopped.

To post without asking in one workspace, set this yourself in its entry in
`workspaces.json`; writes there then need `WORKIT_YT_WRITE=1` instead, and the
shell hook lets raw `ytrack` writes through:

```json
{ "name": "work", "glob": "/home/*/work/**", "youtrack": { "writes": "auto" } }
```

## Which YouTrack a folder uses

ytrack picks its host from `--host`, a URL, `YTRACK_HOST`, then the folder's
path glob (`ytrack auth paths`), then its default host. Workit sets
`YTRACK_HOST` for its own ytrack calls only, so an agent's own `ytrack` in a
workspace reaches the right instance only when that workspace's folder is
mapped to its YouTrack host. For each workspace with a `youtrack.baseUrl`:

- `workit doctor` shows a `ytrack_paths` row: it passes when the workspace
  glob is mapped to that host, and warns when it is missing or mapped to
  another host, with the exact fix, for example
  `ytrack auth paths --host acme.youtrack.cloud --add '/home/you/work/**'`.
  An older ytrack without `ytrack auth paths` gets `ytrack upgrade` first.
- `workit setup` plans the missing `ytrack auth paths --add` calls with its
  other changes and runs them when it applies.

Neither changes `workspaces.json`.

## How the verbs run ytrack

Workit runs `ytrack issue view|create|comment` and `ytrack work-item add|list`
with `--json`, and `ytrack issue attach|command` for files and commands.

- Exit 0 is success.
- ytrack missing: the command exits 5 (`unavailable`) and the unblock names
  the install and `ytrack auth login --host <host>`. Nothing is sent.
- Exit 4 (not logged in): the command exits 5 (`unavailable`) with
  `ytrack auth login --host <host>` as the fix. Nothing is sent.
- Exit 2 (cancelled) wrote nothing.
- Exit 1 is a failure; for a write Workit reads the issue back to learn
  whether it landed.
