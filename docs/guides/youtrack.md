# YouTrack issues

Workit reads and writes YouTrack through its own verbs. An agent never reads
the token file or calls the YouTrack API by hand.

```sh
workit youtrack show ABC-123 --json
WORKIT_YT_WRITE=1 workit youtrack create --project ABC --summary "Crash on start" --file notes.md
workit youtrack note ABC-123 --markdown "Fixed in #42" --minutes 30
workit youtrack time ABC-123 --minutes 45 --text "Code review"
workit youtrack meeting ABC-123 --minutes 30 --text "Planning"
```

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
description comes from `--description <text>` or `--file <path>`. A create is
a write, so it is refused unless `WORKIT_YT_WRITE=1` is set, the same flag the
other YouTrack writes use.

## ytrack first, the built-in client as fallback

`show` and `create` run [`ytrack`](https://github.com/BrainerVirus/youtrack-cli)
with `--json` when it is on `PATH`. ytrack keeps its token in the OS keyring,
so Workit never touches it. Order:

1. `ytrack` on `PATH`: Workit runs `ytrack issue view|create … --json`. When
   `youtrack.json` sets `baseUrl`, Workit passes it as `YTRACK_HOST`, so both
   clients talk to the same instance.
2. `ytrack` missing, or it exits 4 (not logged in): the built-in client reads
   `youtrack.json` and its token file. The token goes only into the request
   header and is redacted from every error.
3. Neither works: the command exits 5 (`unavailable`) and names
   `ytrack auth login` as the fix.

Any other ytrack failure (an unknown issue, a bad project) is reported as is.
Workit does not retry it through the built-in client, so a create is never
sent twice.

`note`, `time` and `meeting` still use the built-in client. Each write carries
a marker and is read back first, so a retry never posts twice.
