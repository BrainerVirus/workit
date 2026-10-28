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
| `release` | needs a grant | `workit git push --release <ref>`: finishing a release or hotfix by pushing the git-flow main and develop branches and release tags (`v*`, or the prefix in `gitflow.prefix.versiontag`, which may be empty) whose commit already landed, which `workit git push` refuses; outside git-flow, tags only. Fast-forward only, a tag never moves; the `push` grant and its account check apply too (see [Releasing](#releasing)) |
| `defaultEndpoint` | `commit` | Where an unnamed delivery request stops, lowest to highest: `commit`, `pr`, `green`, `merged` (skills read it; see [Default endpoint](#default-endpoint)) |
| `verification` | `proportional` | What a change needs: `proportional` (the diff's [review lane](verification.md#review-lanes) decides, merge included: `none` no verdict, `self` the author's `--self` verdict, `focused`/`full` a non-author one), `self` (observed `workit check test` plus the author's own `--self` verdict at normal risk, shown as self-reviewed; merge needs a non-author verdict) or `independent` (a verdict from a session that did not author it). High risk always needs an independent live `verified` verdict |

Without a merge grant the ceiling is: PR or stack opened, CI green,
independently verified. Explicit grants need `vcs.account` for forge effects.
Protected-branch pushes stay denied, except git-flow main and develop under
the `release` grant ([Releasing](#releasing)); outside git-flow a protected
branch only moves through a PR.

## Releasing

`release: true` (`workit grant set <workspace> release=true`, from your own
terminal) lets an agent finish a release or hotfix:

```bash
workit git push --release main --release develop --release v4.1.0
```

Only the git-flow production and develop branches and release tags (`v<digit>…`, or git-flow's `gitflow.prefix.versiontag` prefix, empty for bare `4.1.0`) are
accepted (outside git-flow, tags only); branches move fast-forward only, a
tag's commit must already be on the production branch (or on a branch in the
same push), and a tag moves only when the remote lacks it, in one atomic push that is verified and recorded as `release.pushed`.
Without the grant the push is refused with `grant_required` and this unblock.
A raw `git push` of git-flow main or develop, or of a tag, is denied with the
same command.
See [delivery](delivery.md#release-push).

## Merging

`merge: true` and `merge: "verified"` both merge only a READY PR whose head
has the verdict its [review lane](verification.md#review-lanes) asks for
under `verification: "proportional"` (none for `none`, the author's `--self`
for `self`), else an accepted independent `verified` or `tests-verified`
verdict (`workit ledger check`; `type-check-only` never counts). Without it,
`pr merge` refuses with `NEEDS_VERDICT` and `stack land` stops at
`no_verdict`; the unblock names the verifier route.

A raw merge skips both checks, so inside a Workit workspace the shell hook
denies it on every host and names `workit pr merge`: `gh pr merge`, `glab mr
merge`, and `gh api`/`glab api` writes to a merge endpoint
(`repos/{owner}/{repo}/pulls/<n>/merge`, `repos/<o>/<r>/merges`,
`projects/<id>/merge_requests/<iid>/merge`, with `-X`/`--method` or fields
in any order) or a GraphQL merge mutation. The same hook applies the
protected-branch and branch-name checks to raw `git push` and branch
creation through git aliases, `push.default`, glob refspecs, `stash branch`,
`update-ref`, `fetch <src>:<dst>`, `symbolic-ref`, and commands nested in
`eval`, `xargs`, `if`/`for` bodies, `bash -c` or `pwsh -Command`. Names a
shell computes at run time, scripts and other interpreters are host limits;
server-side branch protection stays the backstop.

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
any step down `verification`'s `independent` > `self` > `proportional`,
including unsetting it) needs you
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
| `merged` | everything in `green`, then `workit pr merge` once the verdict the merge gate asks for is recorded |

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
wins; equally specific matches need an explicit workspace name.
`workit workspace list` shows which entry applies to the current directory and
why; `workit workspace add|set` adds or edits an entry without the wizard and
never raises a grant ([config files](configuration.md#config-files)). The
`WORKFLOW_TOOLKIT_CONFIG`, `WORKFLOW_TOOLKIT_CONFIG_DIR` and `XDG_CONFIG_HOME`
overrides never redirect grants: while one is set, grants resolve to the
defaults.

## Trust model

This stops an honest agent from raising its own grants, not an adversarial
one: a process that drives a pseudo-terminal, clears the agent markers or
edits `workspaces.json` directly can get past it. The hard boundary is your
host's permission prompt: deny or ask on `workit grant set` and on edits under
`~/.config/workit`, and allowlist only read verbs (such as `workit pr status`
and `workit grant show`). The block `workit setup` writes follows that rule:
it allows Workit's gated delivery verbs, never `workit grant`, and asks for
`--unverified` ([hosts](hosts.md#host-permissions-workit-setup)).

A legacy `autoApprove` setting is read once as grants (its merge class becomes
`merge: "verified"`) and folded into `autonomy` on the next `workit grant`
write.
