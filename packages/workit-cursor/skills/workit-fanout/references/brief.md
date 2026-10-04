# Worker brief template

Every field is required. A brief with an empty field is not spawned. Point to
files and ledger rows instead of pasting their content.

```md
GOAL: <one observable outcome, in the user's terms>
SCOPE: <file-scope manifest: the globs this worker may write; everything else is read-only>
  branch: <type>/<slug>   base: <trunk or parent branch>
CONTEXT: <pointers: spec section, ledger decisions, the neighbour file to imitate>
ACCEPTANCE:
  - Given <state>, When <action>, Then <observable result>
VERIFY: <exact commands, e.g. `workit check test`, the verify-<app> feature to drive>
TIMEBOX: <wall clock or turn budget; past it without a new commit you will be replaced>
FORBIDDEN: <no edits outside SCOPE; no rebase, retarget, merge or force-push; no new dependencies; ...>
REPORT: branch, head SHA, files changed, each VERIFY command with its exit code,
  each ACCEPTANCE line met / not met, rulings you made (`workit ledger ruling`),
  anything out of scope as a follow-up, not a diff.
STANDING: <the standing orders, verbatim: user preferences and every directive given so far>
```

## Worked example

```md
GOAL: `GET /v1/usage` returns the workspace's run count per UTC day for the last 7 days.
SCOPE: src/routes/usage.ts, src/queries/usage.ts, test/usage.test.ts
  branch: feature/usage-endpoint   base: main
CONTEXT: spec docs/usage/spec.md "Behavior"; ledger decision "counts are per UTC day";
  imitate src/routes/runs.ts for auth and error shape.
ACCEPTANCE:
  - Given 3 runs today and 1 yesterday, When GET /v1/usage, Then the last two entries are {"runs":1} and {"runs":3}
  - Given no auth header, When GET /v1/usage, Then the status is 401
VERIFY: `workit check test`; verify-api feature "usage"
TIMEBOX: 45 minutes
FORBIDDEN: no edits outside SCOPE; no schema migration; no rebase or force-push; no new packages
REPORT: as in the template
STANDING: conventional commits; no comments that restate code; ask nothing, record rulings instead
```

## Worker rules (paste into the brief when the host has no implementer agent)

1. First command: `workit git branch <branch>` (the worktree may start on a
   name that breaks branch policy).
2. Decide ambiguities yourself and record them:
   `workit ledger ruling "<what>" --why "<why>" --cost-if-wrong "<cost>"`.
   Stop only for an irreversible action, a security-sensitive one, or a side
   effect outside the worktree.
3. Commit with `workit git commit`; push only if the brief says so.
4. Never record a verdict on your own work.
