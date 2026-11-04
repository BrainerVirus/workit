# YouTrack issues

Workit reads and writes YouTrack through its own verbs, and those verbs run
[`ytrack`](https://github.com/BrainerVirus/youtrack-cli) when it is installed.
An agent never reads a token file or calls the YouTrack API by hand.

```sh
workit youtrack show ABC-123 --json
WORKIT_YT_WRITE=1 workit youtrack create --project ABC --summary "Crash on start" --file notes.md
WORKIT_YT_WRITE=1 workit youtrack note ABC-123 --markdown "Fixed in #42" --minutes 30
WORKIT_YT_WRITE=1 workit youtrack time ABC-123 --minutes 45 --text "Code review"
WORKIT_YT_WRITE=1 workit youtrack meeting ABC-123 --minutes 30 --text "Planning"
```

## Set up ytrack (the secure path)

Install ytrack and log in once: `ytrack auth login`. ytrack keeps the token in
the OS keyring. When ytrack is on `PATH`, Workit uses it for every YouTrack
call and never reads its own `youtrack.token`. When `youtrack.json` sets
`baseUrl`, Workit passes it to ytrack as `YTRACK_HOST`, so both talk to the
same instance. Workit never passes a token to ytrack.

`workit doctor` shows a `youtrack` row whenever `youtrack.json` exists or a
workspace links YouTrack issues. It runs `ytrack auth status` and passes when
ytrack is logged in to every configured host. It warns when ytrack is logged
out of a host (the fix is `ytrack auth login --host <host>`) or when
ytrack is missing and Workit falls back to the deprecated token file.

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

## Which client runs

1. `ytrack` on `PATH`: Workit runs `ytrack issue view|create|comment` and
   `ytrack work-item add|list` with `--json`. Exit 0 is success. Exit 4 (not
   logged in) stops with `ytrack auth login` as the fix; Workit does not fall
   back to the token file. Exit 2 (cancelled) wrote nothing. Exit 1 is a
   failure; for a write Workit reads the issue back to learn whether it landed.
2. `ytrack` missing: the built-in client reads `youtrack.json` and its token
   file. This fallback will be removed in a later release; install ytrack.
   The token goes only into the request header and is redacted from errors.
3. Neither works: the command exits 5 (`unavailable`) and says how to set up
   ytrack.
