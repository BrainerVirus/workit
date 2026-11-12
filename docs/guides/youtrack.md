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

## Writes ask you first

Every write (`create`, `note`, `time`, `meeting`) waits for your yes, in every
workspace. The first run records a request and refuses with
`approval_needed`; nothing is posted. The agent runs `workit approve <id>`,
your host shows the issue, the text, the minutes and the day, and the agent's
next run uses your yes once. See [Approvals](approvals.md) for how each host
asks and for the terminal fallback. A changed text or length needs a new yes.

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

To post without asking in one workspace, set this yourself in its entry in
`workspaces.json`; writes there then need `WORKIT_YT_WRITE=1` instead:

```json
{ "name": "work", "glob": "/home/*/work/**", "youtrack": { "writes": "auto" } }
```

## How the verbs run ytrack

Workit runs `ytrack issue view|create|comment` and `ytrack work-item add|list`
with `--json`.

- Exit 0 is success.
- ytrack missing: the command exits 5 (`unavailable`) and the unblock names
  the install and `ytrack auth login --host <host>`. Nothing is sent.
- Exit 4 (not logged in): the command exits 5 (`unavailable`) with
  `ytrack auth login --host <host>` as the fix. Nothing is sent.
- Exit 2 (cancelled) wrote nothing.
- Exit 1 is a failure; for a write Workit reads the issue back to learn
  whether it landed.
