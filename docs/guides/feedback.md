# Reporting Workit friction

When Workit itself gets in the way (a verb fails wrongly, a hook blocks a
call it should not), the agent offers you `workit feedback`, once per
distinct problem, and keeps working on your task. The verb drafts an issue
for the Workit tracker, the repository in the CLI package's bugs URL
(`BrainerVirus/workit`), from any workspace.

```sh
workit feedback "pr status fails outside a checkout" --body-file - \
  --verb "workit pr status" --exit-file err.txt < repro.md
```

The body is a minimal synthetic repro. The verb adds the Workit version, the
host, the platform, the failing verb (`--verb`) and its exit text
(`--exit-file`), then:

- **Redacts the draft.** Remote URLs, absolute and home paths, the current
  branch, ticket IDs (`ABC-123`) and the workspace's org, repository and
  workspace names are replaced with `<url>`, `<path>`, `<branch>`, `<ticket>`
  and `<name>`. Tokens and passwords are always masked. `--include-workspace`
  keeps the workspace details; use it only when you want them in a public
  issue.
- **Searches for a duplicate.** It lists up to three open issues that match
  the title, each with the `--comment <n>` that adds the report to it
  instead of opening a new one.
- **Posts nothing by default.** Without `--post` the draft is saved under
  `workit dir retros` and its path printed, so you can read it, edit it and
  post it later.

## Posting

```sh
workit feedback "pr status fails outside a checkout" \
  --body-file <saved draft> --post --account <login> [--comment <n>]
```

`--post` creates the issue (or the comment) with the GitHub login from
`--account`, else `feedback.account` in workspaces.json. A work workspace's
own account is never used by default: with no login named, `--post` refuses
and prints the `Retry as:` line with `--account <login>`. The token comes
from `gh auth token --user <login>` and is never printed, so the login must
be signed in to gh (`gh auth login`) on github.com.

The hosts ask you before the verb runs: Claude Code and Codex have an ask
rule for `workit feedback`, Cursor never allows it, so its own approval asks,
and OpenCode leaves it as an ask. Pi has no permission layer: there the agent
must have your yes before it passes `--post`.

## Configuration

In workspaces.json (see [configuration](configuration.md#feedback)):

```json
{
  "feedback": { "account": "your-personal-login" },
  "workspaces": [
    { "name": "client", "glob": "/home/you/client/**", "feedback": "off" }
  ]
}
```

A workspace with `"feedback": "off"` (nested workspaces inherit it) drops
the contract line on Claude Code, Codex and Cursor and makes the verb
refuse. OpenCode and Pi show the contract line without a session directory,
so the line stays there, but the verb still refuses.
