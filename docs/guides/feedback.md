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
(`--exit-file`). Without both flags it takes the session's last failing
Workit verb and its output instead, when that failure is under a day old,
and says so in the draft's header. Then it:

- **Redacts the draft.** URLs (credentials included), `user@host:path`
  remotes, emails, host names other than github.com, IP addresses, absolute,
  home, UNC and relative paths (`/` or `\`), the current branch, ticket IDs (`ABC-123`,
  `app-123`) and the workspace's org, repository and workspace names are
  replaced with `<url>`, `<email>`, `<host>`, `<path>`, `<branch>`,
  `<ticket>` and `<name>`. The tracker's own URLs stay. Tokens and passwords
  are always masked, inside a kept tracker URL too, and so is the value after
  a secret-named flag (`--password x`, `--client-secret=x`). Workit's own paths
  (`packages/workit-cli/…`, `@workit-dev/cli/…`) and public names such as
  `npmjs.com` and `socket.io` stay. `--include-workspace`
  keeps the workspace details; use it only when you want them in a public
  issue.

  Redaction matches patterns, so it can miss a single-label host
  (`build-server:8080`), an unknown domain (`foo.acme`), a single-label
  email (`ops@acme`) or a bare user name. Read the whole draft before
  `--post`; the printed draft says so too.
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

The hosts ask you before the verb runs. Claude Code asks on every spelling
(its hook also reads `workit --cwd <dir> feedback`, `workit --session=<id>
feedback`, `env X=1 workit feedback`, `npx @workit-dev/cli feedback`,
`bunx @workit-dev/cli feedback`, `bash -c "workit feedback …"` (behind `env`,
`sudo`, `timeout`, `nohup` or `command` too) and `eval 'workit feedback …'`); Codex asks on `workit feedback …` and refuses any other spelling
with the plain one; OpenCode gets shell ask rules from `workit setup`; Cursor
never allows it, so its own approval asks. Pi has no permission layer: there
the agent must have your yes before it passes `--post`.

The token lookup runs without `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`, so a work token in the
environment never stands in for the account you named.

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
the contract line on every host and makes the verb refuse. OpenCode reads
the setting once per session directory, so a change shows in its next
session.
