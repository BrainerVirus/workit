# YouTrack issues

Workit reads and writes YouTrack through its own verbs, and those verbs run
[`ytrack`](https://github.com/BrainerVirus/youtrack-cli). ytrack is required:
Workit never reads, writes, prompts for or stores a YouTrack token, and an
agent never calls the YouTrack API by hand.

```sh
workit youtrack show ABC-123 --json
WORKIT_YT_WRITE=1 workit youtrack create --project ABC --summary "Crash on start" --file notes.md
WORKIT_YT_WRITE=1 workit youtrack note ABC-123 --markdown "Fixed in #42" --minutes 30
WORKIT_YT_WRITE=1 workit youtrack time ABC-123 --minutes 45 --text "Code review"
WORKIT_YT_WRITE=1 workit youtrack meeting ABC-123 --minutes 30 --text "Planning"
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

Every write (`create`, `note`, `time`, `meeting`) is refused unless
`WORKIT_YT_WRITE=1` is set. A comment or work item carries a marker and is read
back before writing, so a retry never posts twice.

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
