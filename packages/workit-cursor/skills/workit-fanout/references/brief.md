# Worker brief template

Every field is required. A brief with an empty field is not spawned. Point to
files and ledger rows instead of pasting their content.

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
FORBIDDEN: <no edits outside SCOPE; no rebase, retarget, merge or force-push; no new dependencies; ...>
REPORT: branch, head SHA, files changed, each VERIFY command with its exit code,
  each ACCEPTANCE line met / not met, rulings you made (`workit ledger ruling`),
  anything out of scope as a follow-up, not a diff.
STANDING: <the standing orders, verbatim: user preferences and every directive given so far>
  export WORKIT_SESSION_ID=<lead>-w<n>   (set by the lead; a verifier brief gets <lead>-v<n>)
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
FORBIDDEN: no edits outside SCOPE; no schema migration; no rebase or force-push; no new packages
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
is the slice's STUCK threshold in `workit fanout status`.

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

## Worker rules (paste into the brief when the host has no implementer agent)

1. First command. `MODE: new`: `workit git branch <branch> --base <base>` (the
   worktree may start on a name that breaks branch policy). `MODE: resume`:
   `git switch <branch>` (the branch exists; the lead removed the dead
   worker's worktree after its exit, so the switch succeeds), then continue
   from its head.
2. Decide ambiguities yourself and record them:
   `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>"`.
   Stop only for an irreversible action, a security-sensitive one, or a side
   effect outside the worktree.
3. Commit with `workit git commit -m "<msg>" -- <paths in SCOPE>`; push only if
   the brief says so.
4. Never record a verdict on your own work.
