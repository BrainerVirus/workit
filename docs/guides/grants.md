# Autonomy grants

Grants decide how far an agent may deliver without asking. They live only in
your workspace entry in `~/.config/workit/workspaces.json`, never in a
repository.

```json
{
  "name": "personal",
  "glob": "/home/you/projects/personal/**",
  "vcs": { "provider": "github", "account": "you" },
  "autonomy": { "push": true, "pr": true, "merge": "verified", "release": false, "rerun": true },
  "defaultEndpoint": "pr",
  "verification": "independent"
}
```

| Grant | Default | Gates |
| --- | --- | --- |
| `push` | allowed | `workit git push`, `stack sync` |
| `pr` | allowed | `workit pr create` |
| `rerun` | allowed | `workit ci rerun` |
| `merge` | needs a grant | `workit pr merge`, `stack land`. `"verified"`: only with an accepted independent verdict; `true`: without one |
| `release` | needs a grant | Reserved; no verb consumes it yet |
| `defaultEndpoint` | `commit` | Where an unnamed request stops: `commit` or `pr` (skills read it) |
| `verification` | `self` | What a normal-risk behavior change needs: `self` (observed `workit check test` plus the author's own `--self` verdict, shown as self-reviewed) or `independent` (a verdict from a session that did not author it). High risk always needs an independent live `verified` verdict |

Without a merge grant the ceiling is: PR or stack opened, CI green,
independently verified. Explicit grants need `vcs.account` for forge effects.
Protected-branch pushes stay denied.

## Managing grants

```bash
workit grant show [<workspace>] [--all]
workit grant set personal merge=verified defaultEndpoint=pr verification=independent
workit grant unset personal merge
```

Raising a grant (including `defaultEndpoint` from `commit` to `pr`, and
`verification` from `independent` back to `self`) needs you
at an interactive terminal, typing the workspace name to confirm. Headless and
agent shells (no TTY, or an agent marker such as `CLAUDECODE`, `OPENCODE`,
`CURSOR_AGENT`, `PI_CODING_AGENT`, `AI_AGENT`, `AGENT` or any `CODEX_*`) are
refused with `blocked` and the command to run yourself. Lowering is always
allowed. Each write keeps `workspaces.json.bak`.

When workspace globs overlap, the match with the most literal path components
wins; equally specific matches need an explicit workspace name. The
`WORKFLOW_TOOLKIT_CONFIG`, `WORKFLOW_TOOLKIT_CONFIG_DIR` and `XDG_CONFIG_HOME`
overrides never redirect grants: while one is set, grants resolve to the
defaults.

## Trust model

This stops an honest agent from raising its own grants, not an adversarial
one: a process that drives a pseudo-terminal, clears the agent markers or
edits `workspaces.json` directly can get past it. The hard boundary is your
host's permission prompt: deny or ask on `workit grant set` and on edits under
`~/.config/workit`, and allowlist only read verbs (such as `workit pr status`
and `workit grant show`).

A legacy `autoApprove` setting is read once as grants (its merge class becomes
`merge: "verified"`) and folded into `autonomy` on the next `workit grant`
write.
