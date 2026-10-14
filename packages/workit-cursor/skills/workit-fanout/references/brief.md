# Worker brief template

`workit fanout brief <slice>` renders this brief from the plan, the standing
orders in force (`workit ledger standing list`) and the slice's scratch dir;
pass its output verbatim. The template below is what it fills in. Every field
is required. A brief with an empty field is not spawned. Point to files and
ledger rows instead of pasting their content. Size the slice so the worker
finishes it in about 150k tokens of context; split a larger one first.

```md
MODE: <new | resume (a replacement continuing an existing branch)>
GOAL: <one observable outcome, in the user's terms>
SCOPE: <file-scope manifest: the globs this worker may write; everything else is read-only>
  branch: <type>/<slug>   base: <trunk or parent branch>
CONTEXT: <pointers: spec section, ledger decisions, the neighbour file to imitate>
ACCEPTANCE:
  - Given <state>, When <action>, Then <observable result>
VERIFY: <exact commands, e.g. `workit check test`, the verify-<app> feature to drive>
TIER: <mundane | standard | hard: how much model the slice needs>
TIMEBOX: <wall clock or turn budget; past it without a new commit you will be replaced>
SCRATCH: <your own temp dir: the one `fanout worktree create` printed, else `mktemp -d`; never a shared path>
FORBIDDEN: <no edits outside SCOPE; no new dependencies; ...>
FAN-IN: <one PR per slice: no rebase, retarget, merge or force-push | integration: merge the integration tip before reporting, nothing else>
REPORT: branch, head SHA, files changed, each VERIFY command with its exit code,
  each ACCEPTANCE line met / not met, rulings you made (`workit ledger ruling`),
  anything out of scope as a follow-up, not a diff.
STANDING: <the standing orders, verbatim: `workit ledger standing add` records each one>
  <identity line, per the lead's host: see "Identity and git rules per host" below>
```

## Worked example

```md
MODE: new
GOAL: `GET /v1/usage` returns the workspace's run count per UTC day for the last 7 days.
SCOPE: src/routes/usage.ts, src/queries/usage.ts, test/usage.test.ts
  branch: feature/usage-endpoint   base: main
CONTEXT: spec docs/usage/spec.md "Behavior"; ledger decision "counts are per UTC day";
  imitate src/routes/runs.ts for auth and error shape.
ACCEPTANCE:
  - Given 3 runs today and 1 yesterday, When GET /v1/usage, Then the last two entries are {"runs":1} and {"runs":3}
  - Given no auth header, When GET /v1/usage, Then the status is 401
VERIFY: `workit check test`; verify-api feature "usage"
TIER: standard
TIMEBOX: 45 minutes
SCRATCH: ../app-wt/usage-endpoint/.workit-scratch
FORBIDDEN: no edits outside SCOPE; no schema migration; no new packages
FAN-IN: one PR per slice. Never rebase, retarget, merge or force-push: the lead owns topology.
REPORT: as in the template
STANDING: conventional commits; no comments that restate code; ask nothing, record rulings instead
```

## Plan file

`workit fanout plan <plan.json>` records the slices before any spawn. Each
slice carries the brief fields the plan checks (goal, scope, acceptance,
verify, forbidden must be filled; tier is mundane, standard or hard). `base`
defaults to the trunk, or to the branch of a single `dependsOn` slice (a
stack); `worktree` defaults to `../<repo>-wt/<id>`. `owns` claims a shared
file another slice's glob also matches. Globs that match no file yet are compared
through a sample path. Use `/` as the separator; a backslash only escapes
literal brackets: `"app/\\[id\\]/page.tsx"`. A `timebox` such as `45 minutes`
is the slice's STUCK threshold in `workit fanout status`. `"fanIn":
"integration"` (with an integration branch as `trunk`) is the one-PR mode in
`orchestration.md`; the default `"prs"` lands one PR per slice.

```json
{
  "name": "usage",
  "trunk": "main",
  "slices": [
    {
      "id": "usage-endpoint",
      "branch": "feature/usage-endpoint",
      "tier": "standard",
      "scope": ["src/routes/usage.ts", "src/queries/usage.ts", "test/usage.test.ts"],
      "owns": ["package.json"],
      "goal": "GET /v1/usage returns the run count per UTC day for the last 7 days",
      "acceptance": ["Given no auth header, When GET /v1/usage, Then the status is 401"],
      "verify": ["workit check test"],
      "forbidden": ["no edits outside SCOPE", "no rebase or force-push"],
      "context": "docs/usage/spec.md Behavior",
      "timebox": "45 minutes"
    },
    {
      "id": "usage-docs",
      "branch": "docs/usage",
      "tier": "mundane",
      "dependsOn": ["usage-endpoint"],
      "scope": ["docs/usage/**"],
      "goal": "The API guide documents GET /v1/usage",
      "acceptance": ["Given the guide, When a reader looks up usage, Then the response shape is shown"],
      "verify": ["workit check docs"],
      "forbidden": ["no edits outside SCOPE"]
    }
  ]
}
```

## Identity and git rules per host

`workit fanout brief` renders the identity line and RULES 1 and 3 for the
lead's host (`WORKIT_HOST`, or the host's own session variable):

| Lead's host | Identity line | RULES 1 and 3 |
| --- | --- | --- |
| Claude Code | `Session: your env already has WORKIT_SESSION_ID (the lead's id)`; no `export`, no hand-minted id (SubagentStart issues `<lead>:<agent id>` only to verifiers and reviewers, never to an implementer, so the worker's commits carry the lead's id) | plain git: `git fetch origin && git switch -c <branch> origin/<base>` and `git commit -m <msg> --trailer "Workit-Session: <the env WORKIT_SESSION_ID>" --trailer "<host attribution>" -- <paths in SCOPE>`, because worktree isolation refuses every `workit git` form |
| OpenCode, Pi, Codex | `Session: your host already sets WORKIT_SESSION_ID in your shell`; export nothing (the host derives the id and an export cannot replace it) | `workit git branch <branch> --base <base>`, `workit git commit -m <msg> -- <paths in SCOPE>` |
| Cursor, CI, a plain terminal | `export WORKIT_SESSION_ID=<lead>-w-<slice>` (`+try<n>` for a race attempt): declared, not checked | the same `workit git` forms |

`MODE: resume` is `git switch <branch>` on every host (the branch exists; the
lead removed the dead worker's worktree after its exit, so the switch
succeeds), then continue from its head. A race attempt (`--attempt <n>`)
follows its host's row with the branch `<branch>-try<n>`.

## Worker rules (`workit fanout brief` appends them as RULES)

1. First command: create the branch (`MODE: new`; the worktree may start on a
   name that breaks branch policy) or `git switch` to it (`MODE: resume`),
   as the table above says for your host.
2. Decide ambiguities yourself and record them:
   `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>"`.
   Stop only for an irreversible action, a security-sensitive one, or a side
   effect outside the worktree.
3. Commit as the table says (`workit git commit -m "<msg>" -- <paths in SCOPE>`,
   or plain git with the trailers on Claude Code); push only if the brief says
   so.
4. Never record a verdict on your own work.
