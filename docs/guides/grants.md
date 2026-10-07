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
| `merge` | needs a grant | `workit pr merge`, `stack land`. Both need an accepted independent verdict. `true` also allows `--unverified --reason "<why>"`, a bypass recorded in the ledger; `"verified"` never does (see [Merging](#merging)) |
| `release` | needs a grant | Reserved; no verb consumes it yet |
| `defaultEndpoint` | `commit` | Where an unnamed delivery request stops, lowest to highest: `commit`, `pr`, `green`, `merged` (skills read it; see [Default endpoint](#default-endpoint)) |
| `verification` | `self` | What a normal-risk behavior change needs: `self` (observed `workit check test` plus the author's own `--self` verdict, shown as self-reviewed) or `independent` (a verdict from a session that did not author it). High risk always needs an independent live `verified` verdict |

Without a merge grant the ceiling is: PR or stack opened, CI green,
independently verified. Explicit grants need `vcs.account` for forge effects.
Protected-branch pushes stay denied.

## Merging

`merge: true` and `merge: "verified"` both merge only a READY PR whose head
has an accepted independent `verified` or `tests-verified` verdict (`workit
ledger check`; `type-check-only` never counts). Without one,
`pr merge` refuses with `NEEDS_VERDICT` and `stack land` stops at
`no_verdict`; the unblock names the verifier route.

Only under `merge: true` can you merge without a verdict, and only by
asking for it: `workit pr merge --unverified --reason "<why>"` (or `workit
stack land --unverified --reason "<why>"`). `--reason` is required. Before
the merge call Workit records a `merge.unverified` ledger row with the
session, the PR, its head and the reason. If that row cannot be written,
nothing merges. `--unverified` covers a missing verdict, never a rejection:
a current independent `failed` or `blocked` verdict refuses it with
`failed_verdict` until a new independent verdict on the head supersedes it.
Under `merge: "verified"`, `--unverified` is refused with
`unverified_refused`, and without a merge grant with `grant_required`. Agents
pass `--unverified` only when the user asks for it.

Before 8.0, `merge: true` merged without a verdict check. To keep that
behavior for a merge, pass `--unverified --reason "<why>"`. To forbid the
bypass, switch to `workit grant set <workspace> merge=verified`.

## Managing grants

```bash
workit grant show [<workspace>] [--all]
workit grant set personal merge=verified defaultEndpoint=pr verification=independent
workit grant unset personal merge
```

Raising a grant (including any step up `defaultEndpoint`'s
`commit` < `pr` < `green` < `merged`, and
`verification` from `independent` back to `self`) needs you
at an interactive terminal, typing the workspace name to confirm. Headless and
agent shells (no TTY, or an agent marker such as `CLAUDECODE`, `OPENCODE`,
`CURSOR_AGENT`, `PI_CODING_AGENT`, `AI_AGENT`, `AGENT` or any `CODEX_*`) are
refused with `blocked` and the command to run yourself. Lowering is always
allowed. Each write keeps `workspaces.json.bak`.

## Default endpoint

`defaultEndpoint` says how far an agent goes when a request implies delivery
(fix, implement, ship) but names no endpoint:

| Value | The agent stops at |
| --- | --- |
| `commit` | a local commit on a policy-compliant branch (default) |
| `pr` | the pushed branch with its PR open |
| `green` | the PR merge-ready: it keeps babysitting without asking (`workit ci wait` in the background, one `workit ci rerun` for a clear flake or infra failure, otherwise a fix; review threads answered; the branch rebased when the forge requires it; a draft marked ready) until CI is green, threads are resolved and the verification gate is met. It never merges |
| `merged` | everything in `green`, then `workit pr merge` once a non-author verdict is accepted |

The configured endpoint applies only when the request names none; an
explicit "babysit this PR" stops at merge-ready. The agent stops early only
for a new consequential choice, a host denial, a review comment that needs a
product decision, a required branch update that keeps repeating because the
base keeps moving, or after 3 failed fix attempts on the same check. `workit
pr status` reports a `babysit` step for the loop (see
[delivery](delivery.md#babysitting-a-pr)).

The effective endpoint follows the grant checks the delivery verbs make.
`pr`, `green` and `merged` act as `commit` when the `push` or `pr` grant is
false, or when explicit grants have no `vcs.account`. `merged` acts as
`green` without the `merge` grant. `workit grant show` says so and names the
unblock:

```text
  default endpoint: merged (effective: green, merge grant missing; ask the user to run, in their own terminal: workit grant set personal merge=verified) (...)
```

`grant show --json` carries `defaultEndpoint` (the endpoint as read),
`configuredEndpoint` (the raw stored value, `null` when unset),
`effectiveEndpoint` and, when it is lower, `endpointReason`. A value this
version does not know is reported (`endpointIssue`) and read as `commit`;
the rest of the file still applies.

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
