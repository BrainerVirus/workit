# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version model.** Semantic-release computes published versions from
> Conventional Commits. The release workflow rewrites internal dependencies
> for publishing, then synchronizes source manifests through its manifest PR.
> GitHub Releases contain the generated release notes; this file records
> manually maintained changes, including unreleased work.

## [Unreleased]

### Changed (1.0.0: @workit-dev)

- **BREAKING: the packages publish as `@workit-dev/*`, starting at 1.0.0.**
  `@brainervirus/workit-{core,cli,claude-code,opencode,codex,cursor,pi,mcp}`
  become `@workit-dev/{core,cli,claude-code,opencode,codex,cursor,pi,mcp}`.
  This continues the `@brainervirus/workit-*` 14.x line, whose history is
  below. Releases are tagged `workit-dev-v<version>`; the old `v*` tags stay.
  The `workit` command, the GitHub repo and the plugin id `workit@workit` do
  not change. Migrate every install with
  `npx -y @brainervirus/workit-cli@latest upgrade`; `workit doctor` row
  `legacy_scope` lists what is still on the old scope
  ([migration guide](docs/guides/migration.md)).
- The release publishes each package when its payload changed since the
  version the registry serves for it (not since the previous tag), ships
  everything on a first release, and takes `PUBLISH_ALL=1` or `--all`.

### Fixed (retro 2026-11-07)

- **Implementer confinement follows shell variables, loops and inline
  interpreter scripts** (#744). `W=<worktree>; workit git --cwd $W commit` and
  `workit check --cwd $W …` are judged against the worktree, not the lead's
  checkout. A plain `NAME=<literal>` set earlier in the same command,
  `$(mktemp …)` (the path it prints) and a `for` over literal words resolve; a
  loop or conditional untrusts only the names assigned inside its body. An
  inline `python -c`, `node -e`, `ruby -e` or `perl -e` script is judged by
  the paths it names: its run directory counts as a write target, plus every
  absolute, `~` or `..`-climbing path in its text, options, arguments and env
  prefix; a relative `require`/`import` resolves to the run directory, and a
  path Workit cannot resolve is denied. Such a script passes only when it runs
  from the worktree, its scratch or a temp dir and names no path outside
  them. A variable Workit cannot resolve is denied by name, with
  the command reprinted with the path spelled out for the retry. Writes into
  the lead's checkout are still denied.
- **Formatters skip the check lease, and a lease wait re-queues once** (#745).
  `workit check --heavy -- <cmd>` runs a formatter (`oxfmt`, `prettier`,
  `cargo fmt`, `bun run format`) or a linter whose every target is a file at
  once and says why; the shell heavy gate leaves them alone on every host. At
  its wait limit a heavy check keeps its queue place for one more limit and
  prints the estimated wait, then fails with the exact retry command. `workit
  fanout plan` warns when a wave has more full-suite slices than lease slots.
- **Auto mode: a spawn missing its role args is denied with the exact Agent
  args** (#746). Claude Code's auto mode refuses a spawn a hook rewrote, so a
  spawn missing its role's `model`/`effort`, or one setting `isolation`, is
  now denied once with the args to pass (`run_in_background` kept). Other
  modes still fill them in. `workit fanout brief` gives a Claude Code lead
  `SPAWN:` lines and a `checks:` line.
- **Stop honours a live `ci wait`** (#748). The Stop hook no longer asks for a
  `workit ci wait` while one for the same PR and head is already running; it
  lets the stop through with a notice. A second `ci wait` on that PR and head
  exits busy (4, `data.state: in_flight`) naming the running one, without
  polling.
- **A `base_red` refusal names the next step** (#750). `pr merge` on a red
  protected base reads the previous base run: when every failing job passed
  there it says likely flaky and prints the exact
  `workit ci rerun --ref <base> --check "<job>" --reason flake`; when a job
  also failed there it says the base is broken and suggests no rerun.
  `--json` adds `baseRedCause` (`flaky`, `broken`, `unknown`). GitHub only:
  GitLab gets `unknown` and the generic `--failed` rerun hint.
- **A verified verdict needs each configured check** (#751).
  `workit ledger verdict verified|tests-verified` refuses (`check_missing`,
  exit 3) while a configured check has no fresh passing local run on the head
  and the head's PR CI is not green, naming the `workit check <name>` to run or
  `workit ci wait --pr <n>`. A verifier's or reviewer's SubagentStart text
  lists the checks on Claude Code and Codex.

### Added (retro 2026-11-07)

- **CLI grammar aliases** (#743). `workit git add` is an alias of
  `workit git stage`, and `workit git push [-u] origin <current branch>`
  pushes like `workit git push` (another branch name is still refused).
  `workit grant show` prints the workspace-remote note after the grant table.
  A raw `pkill -f <pattern>` gets a nudge toward `pgrep -f '[p]attern'`,
  never a deny.
- **Deslop depth follows the review lane** (#754). `workit deslop scan --diff
  [<base>] [--lane <l>]` classes each comment a branch adds (narration,
  marker, suppression, debug, allowed) with no agent, runs `test-audit` on the
  changed tests and prints the lane's passes; a new marker or suppression
  raises a `none`/`self` lane to `focused`. `workit deslop result --removed N`
  records one `deslop.result` row. `workit test-audit` gains
  `mock-call-order` and `private-access`. From `focused` up, a fresh-eyes
  no-comments pass goes to each host's reviewer. See
  [docs/guides/review.md](docs/guides/review.md).
- **Repo rules from past mistakes** (#747, contributors). `bun run lint` also
  runs four static rules (`spawn-timeout`, `spawn-env-path`,
  `no-wall-clock-assert`, `exit-after-flush`) against a ratchet baseline: a
  new hit fails naming its fix, and `bun run lint:rules --write` shrinks the
  baseline after a fix.

### Changed (retro 2026-11-07)

- **Model evals run locally on the Claude Code subscription** (#749).
  `bun scripts/eval/run.ts --model haiku --tier smoke` runs each case in
  `evals/cases/` as a headless `claude -p` against this checkout, grades the
  transcript's tool calls (never a model), caches results per case, model and
  Workit version, and caps model runs with `--budget-runs` (default 3). The CI
  `claude-eval.yml` workflow and the `claude plugin eval` suite are removed.
  See [docs/agents/eval.md](docs/agents/eval.md).

### Added (config JSON Schemas)

- `workspaces.json`, `config.json`, `vcs.json` and `youtrack.json` have JSON
  Schemas generated from Workit's own validation, published at
  `https://unpkg.com/@brainervirus/workit-core/schemas/<file>.json`. Editors
  complete keys and allowed values, show descriptions and underline unknown
  keys or bad values. `workit setup` and `workit workspace set` write
  `"$schema"` first and keep a value you set yourself; `workit doctor`'s new
  `config_schema` row names the file and JSON path of each bad value (#614).

### Added (changelog and docs checks)

- `changelogPath` takes globs such as `["projects/*/CHANGELOG.md"]`. In a
  monorepo with a changelog per package, `workit pr create` asks for an
  Unreleased entry in the changelog of each package the PR touches and names
  any that lack one; `workit grant show` lists the files the glob matches in
  the checkout (#620).
- When a workspace turns on the changelog or docs step, `workit pr create`
  prints one `changelog:` and one `docs:` line on every run (passed, skipped,
  bypassed or blocked) and records each as a `pr.check` ledger row. The docs
  check never blocks.

### Changed (ledger integrity)

- **`--supersedes` is scoped to one branch and kind.** A row supersedes only
  a row of its own type, session, branch (renames followed) and, for verdicts,
  kind. Old cross-branch or cross-kind supersede links are now ignored, so the
  rows they hid count again; record a fresh verdict where `ledger check`
  changes.
- **Rows carry a hash chain.** `workit ledger verify-integrity` lists rows
  outside it; `ledger check` warns (never blocks). Rows appended by an older
  Workit install read as `unsigned` there until every host is upgraded.
- **Lifting your own blocker needs `--why`.** `policy assess` records a
  `policy.judged` ledger row; a session that judged `product-choice` or
  `plan` yes passes `--why` to judge it no.

### Changed (breaking, merge needs a verdict)

- **`merge: true` needs an accepted independent verdict.** `workit pr merge`
  and `workit stack land` merge only a head with an accepted independent
  `verified` or `tests-verified` verdict, under `merge: true` and
  `merge: "verified"` alike. `type-check-only` never satisfies the merge gate.
  `NEEDS_VERDICT` (or `stack land`'s `no_verdict`) names the verifier route.
- **`--unverified --reason "<why>"` is the explicit bypass.** It works only
  under `merge: true` and only when the user asks for it. Before the merge
  call it records a `merge.unverified` ledger row with the session, PR, head
  and reason, and nothing merges if that row cannot be written. It never
  overrides a current independent failed verdict (`failed_verdict`). Under
  `merge: "verified"` it is refused (`unverified_refused`).
  Migration: pass `--unverified --reason` where a verdict-less merge was
  intended, or set `merge=verified` to forbid the bypass.
- **`workit pr create` prints `next:`** (`next` in `--json`), which names the
  non-author review and what the effective endpoint does after it.
- **Removed** the unused `core/pr-create.ts` `mergePr` and the
  `integration: "merge"` local-merge path of `prCreate`, which could merge
  without these gates.

### Changed (breaking, S17 slim policy)

- **Policy assessment is four flat judgments.** `workit policy assess --judge
  risk=trivial|normal|high behavior=yes|no product-choice=yes|no plan=yes|no
  [--ref <plan>]` (tools: `riskTier`, `behaviorChange`, `productChoiceOpen`,
  `needsPlan`, `note`, `refs`; `low`/`medium` accepted). Workit derives the rest
  and `policy assess` shows each requirement as met or owed. The 6.x
  `assessment` is still accepted and mapped conservatively for one major; its
  schema export, `boundedOperationJsonSchema` and `OPERATION_SCHEMA_DEPTH` are
  gone.
- **Verification by risk.** A behavior change needs an observed
  `workit check test`. At normal risk the verdict may be the author's own
  (`workit ledger verdict tests-verified --self`), which `ledger check` and
  `pr status` show as **self-reviewed**, never verified; the user-config
  workspace setting `verification: "independent"` (`workit grant set`, same
  rules as grants) requires a non-author verdict. High risk needs an
  independent `verified` verdict of kind `live` and a plan. `type-check-only`
  never proves a behavior change.
- **Flat tool schemas.** Every `workit_<family>` tool (MCP, OpenCode, Pi) is one
  flat object (depth 1, no unions); nested payloads still work. Advertised
  family schemas shrink from 21.6 KB to 6.3 KB.
- **Before-write gate.** An open product choice or a missing plan on the
  branch task denies working-tree edits on Claude Code (PreToolUse
  Edit/Write/MultiEdit/NotebookEdit, Bash and PowerShell), OpenCode (permission
  evaluate), Cursor (preToolUse) and Pi (tool_call), naming the unblock.
  Recognizable shell writes only: redirects, tee, `sed -i`/`perl -i`,
  cp/mv/rm/touch/mkdir, dd and working-tree git (apply, restore,
  `checkout --`); interpreters and formatters are not detected, and history
  moves (commit, merge, rebase, stash pop) are never gated. Markdown, top-level
  `docs/`, `plans/`, the cited plan and files outside the checkout stay
  writable; an approved limitation waives the plan. Codex has no pre-write hook:
  the gate is advisory there and the session context says so.

### Removed (breaking, 3.0)

- **OpenCode V1 (`server()`) adapter.** `@brainervirus/workit-opencode` now
  exports only the V2 plugin definition `{ id: "workit", setup }` and requires
  OpenCode 2.0.18+ (support-matrix floor; was 1.18.30). The `@opencode-ai/plugin`
  SDK pin is gone. *Migration:* on OpenCode 1.x stay on Workit 2.x by pinning
  `"plugin": ["@brainervirus/workit-opencode@2"]` (the V1 key); after upgrading
  OpenCode use `"plugins": ["@brainervirus/workit-opencode"]` (2.x still
  normalizes `plugin`). `workit doctor` now fails a 1.x CLI with
  `opencode_version`, and `workit upgrade` warns before applying.
- **`workit cutover`** (preview/apply/rollback of legacy workflow-toolkit
  installs) and its core modules (`cutover.ts`, `legacy-ownership.ts`,
  `config-conversion.ts`). *Migration:* migrate a legacy install with Workit
  2.x first, or reinstall with `workit init`.
- **Doctor check ids** `mixed_generation`, `legacy_component`,
  `missing_v1_component`, `active_old_session` and `managed_content_conflict`
  (cutover-only state), and the `WORKFLOW_TOOLKIT_SESSIONS` input. Consumers of
  `workit doctor --json` must stop expecting them.
- **Core deep imports of admin code.** `@brainervirus/workit-core` no longer
  ships `src/core/{setup,doctor,host-install,uninstall,registration,
  detect-hosts,setup-state}.ts` or `scripts/doctor-check.ts`; they live in
  `@brainervirus/workit-cli` (`src/admin/`, `scripts/doctor-check.ts`), so host
  hooks and plugins no longer bundle them (OpenCode plugin bundle about 28%
  smaller). Use the `workit` CLI instead of deep imports.

### Changed: task event store and implicit tasks

- **Task event store and implicit tasks (3.0, D3/D13).** Task state moves from
  `<checkout>/.workit/` to `$(git rev-parse --git-common-dir)/workit/` (shared
  by all worktrees, kept across worktree removal and `git clean`; non-git
  directories keep `<dir>/.workit/`). Each task is an append-only
  `tasks/<id>/events.jsonl` of structural patches plus a rebuildable
  `snapshot.json`: state grows with the change, not with full-record copies,
  a crash leaves at most a torn last line that the next write truncates, and
  stored candidates are content-addressed blobs. The `.workit/recovery/`
  mechanism and `state.recover` are removed.
- Every branch is one implicit task (detached HEAD: per worktree; non-git:
  per directory). `workit check`, `workit ledger` records, `workit git commit`
  and any task operation without a `taskId` (CLI, MCP, host tools) apply to
  it and create it on first use; host tool schemas make `taskId` optional. An
  explicit `task start` takes the branch over; closing frees it. Per-turn host
  context falls back to the branch's task when no session-bound task applies.
- New `workit task status [--all] | start "<objective>" | note "<text>"
  [--next] [--objective] | close [--outcome] | adopt <id>`.
- `workit gc` now compacts long task logs into a checkpoint plus their 50
  most recent events (the latest state is never lost) and removes
  unreferenced blobs; it reports a 2.x `.workit/recovery/` and deletes it only
  with `--prune-recovery --yes`.
- **Migration:** a 2.x `.workit/` store (tasks and workspace record)
  migrates on the first CLI command or write in that checkout, under the
  checkout lock and the 2.x store's own `metadata.lock` (a live 2.x writer
  makes it `busy`; nothing is migrated under it), with a backup under
  `legacy/<checkout>/v2/` and a one-line note on stderr. Per-turn hooks and
  other reads never migrate; they say `run workit task status`. Tasks migrate
  by content digest, so a 2.x write after an interrupted run is migrated as a
  further event on the next run; each 2.x file is replaced by a marker only
  while it still holds the migrated bytes. Migrated tasks keep their ids and
  contents (inspect output is unchanged), join the checkout's workspace, and
  are not bound to a branch: list them with `workit task status --all`, bind
  one with `workit task adopt <id>`. `.workit/workspace.json` becomes a marker
  (written into every checkout 3.0 writes for, git-ignored) whose critical
  `store` field makes 2.x runtimes fail closed with an upgrade message instead
  of starting a second store. A plain directory's `.workit/` store moves into
  the git store after `git init`.
- A checkout is its worktree top level for every host (a subdirectory is the
  same checkout). Implicit-task creation is serialized per key across the
  store; with duplicate open tasks on a key the oldest is used and `workit
  task status` names the others with a close command. During a rebase the key
  is the branch being rebased; a task follows its branch through `git branch
  -m` (a branch created later under the old name starts a fresh task). reftable repositories and bare
  repositories resolve through git. While a 2.x store waits to migrate, every
  per-turn host context (hooks, OpenCode, Pi) shows `workit migration pending —
  run \`workit task status\``. `workit gc` reports a log another writer
  compacted meanwhile as `retried` (picked up by the next run), not `failed`.

### Added

- `workit init` installs the ytrack agent skill for the hosts you set up when you pick YouTrack (as setup and upgrade do), and names `ytrack upgrade` when your ytrack is too old.
- Agents get a ytrack skill that matches your installed ytrack: when a workspace uses YouTrack, `workit setup` and `workit upgrade` run `ytrack skill install` into each host's skills dir (Claude Code, OpenCode, Codex, Cursor, Pi), `workit doctor` warns when a host's copy is older than ytrack (fix: `workit upgrade --hosts=<host>`) or when ytrack predates `ytrack skill` (fix: `ytrack upgrade`), and `workit uninstall` removes the copies Workit installed. Workit's ship skill points agents at `workit youtrack` verbs first and the ytrack skill for the rest.
- Heavy-check waiters and `workit lock status` show an estimated wait from each check's last measured run, and `resources.slots` above what RAM allows prints a warning.
- `workit fanout brief` adds a skills VERIFY line when a slice's SCOPE touches skills or agent definitions: `workit check skills` when the repo defines that check or group, else a reminder to run the repo's skill and context-budget checks.
- `cleanup.regenerable` in `.workit/checks.json` lists a repo's generated, ignored dirs (globs) so post-merge cleanup and `gc --worktrees` remove worktrees that hold only those.
- `workit dir <plans|retros|handoffs|config|state|data|cache|runtime> [--json]` prints where each kind of Workit file lives; per-clone kinds sit in `.git/workit/` and are shared by every worktree. The shape, fanout, retro and continue skills save their files there.
- `workit ci rerun --ref <branch> --failed --reason flake|infra` reruns the failed jobs of a branch's latest CI run (GitHub and GitLab), with the same once-per-head limit and ledger row as the PR form. A `pr merge` refused for a red base now names it.
- OpenCode and Pi agent shells, the Codex hook and MCP processes and the Cursor hook prefer the owned workit install over a stale copy earlier on PATH (owned bin first on PATH, `WORKIT_CLI` set); nothing changes without an owned install. Claude Code keeps its plugin-bundled CLI (#648).
- `workit check ci` runs the repository's `ci` group from `.workit/checks.json` (light checks at once, heavy ones under the lease) and names every failed member; this repository declares knip, react-doctor and packaging so they run before push, not only in CI.
- `docs/guides/configuration.md` documents usage-limit fallback lists (ordered models per role and `models.lead`, `models.limitWindow`, what each host can switch).
- `workit changelog merge` is a git merge driver that keeps both sides' `[Unreleased]` entries (each heading once, duplicates dropped, conflicts outside Unreleased keep git's markers); `workit changelog driver install` registers it in `.git/config` and `.gitattributes`. This repository routes CHANGELOG.md through it.
- After `workit pr merge` (and `verify-delivery merge`) deletes the remote branch, Workit removes that branch's clean worktree under the managed root and the local branch, records them in the ledger, and keeps and names a dirty one (#653).
- `workit gc --worktrees` lists clean worktrees whose work is on the trunk (merged, or squash-merged by patch-id), including legacy `<repo>-wt` siblings and temp scratch worktrees, with sizes and the reason each kept one stays; `--apply` removes them and prunes their branches (#653).
- `workit doctor` lists every workit install on PATH and in version-manager prefixes (`cli_installs`) and fails when one shadows the owned launcher.
- Grant and workspace output highlights what changed: bold names, `old -> new` in green for a raise and yellow for a lower, unchanged rows dimmed; plain under NO_COLOR or without a TTY (#656).
- `workit workspace set --global <key>=<value>` edits the top-level `models` key in workspaces.json.
- `workit pr merge` refuses a PR authored by someone other than your forge login (case-insensitive; bots included) with `others_pr`; `--others-pr --reason "<why>"` merges it anyway, records the reason in the ledger and never deletes that author's branch (#442). When Workit cannot read the PR author or your login it refuses with `identity_unknown` and points to `gh auth login` / `glab auth login`.
- Usage-limit fallback (#655): a role in `models.roles` (or `models.lead`) can list models in fallback order, e.g. `"verifier": { "opencode": ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] }`. When a provider hits its usage limit (Anthropic 5-hour or weekly, OpenAI usage limit or quota, a long 429), Workit marks it exhausted until the reset named in the error (else `models.limitWindow`, default `5h`), runs the next listed model, and returns to the first after the reset. A worker that died on a limit is flagged for one re-dispatch.
- `workit models show` lists exhausted providers with their reset times and prints the lead switch notice; on OpenCode the lead also gets that notice in context once.
- Configured role models (`models.roles`) now apply at spawn on OpenCode: the plugin sets the model on every new subagent, so a verifier or implementer runs on the model you configured instead of inheriting the lead's (#654).
- `models.roles.default` sets the model for general-purpose spawns, `models.lead` records the orchestrator model, and `models.allowLeadOverride: true` lets a model the lead names win over the configured one.
- `workit models show` says per host whether each role model is enforced or only advisory.
- `workit check <name>` / `workit check [--name <n>] -- <cmd…>` runs a check
  and records what the CLI observed (exit code, duration, argv, HEAD, worktree
  tree key before and after, patch-id, a minimal environment fingerprint, a
  redacted bounded log blob and tail) as `observer: workit_cli` evidence in the
  run ledger and the current task. The exit code is the command's. Named checks
  come from a committed `workit.checks.json` (with optional `gates`), else
  detected defaults: package.json scripts, `go test ./...`, `cargo test`,
  `pytest`, `make test`. On POSIX the command runs in its own process group, so
  `--timeout` and its exit kill every process it started; on Windows `.cmd`
  shims (npm, pnpm, node_modules/.bin) run through an escaped `cmd /d /s /c`.
  `workit gc` also prunes check logs (newest 200, 30 days, 256 MB).
- `workit test-audit [paths…|--diff [base]]` reports tautological and
  low-value tests (tautology, mock-echo, snapshot-of-constant, assertion-free,
  byte-copy, duplicate-body, constants-only, always-true, over-mocking; prose
  `toContain` as `info`) with file:line, severity, confidence, why and an
  independent-oracle fix; it never edits files. `--fail-on <level>` gates.
  `--mutate` runs diff-scoped mutants (comparisons, booleans, logic,
  arithmetic, return values) against the related tests in a disposable copy of
  the working tree, using `--test-cmd` or the `workit check test` command, and
  exits 1 when a mutant survives.
- Skills `workit-bdd` (Given/When/Then scenarios as test names and seams) and
  `workit-test-audit` (triage audit findings with Name the Break), with
  `/wk-bdd` and `/wk-test-audit` aliases on every host.
- `workit stack plan|status|sync|land` (S12): forge-neutral stacks of plain
  base-branch PRs on GitHub and GitLab (no Graphite or `gh stack`
  dependency; an adapter seam is left for later). The order and what each
  branch was last built on are cached in `<git common dir>/workit/stacks/`
  (shared across worktrees, surviving worktree removal) and checked against
  git ancestry and the forge's PR bases (a re-plan keeps the recorded base
  and refuses a parent rewritten under an unrecorded child); file names are
  portable (slug + hash). One writer per stack (`busy`, exit 4): the lock
  carries the S1 host/pid-namespace/boot identity and a heartbeat, so a dead
  local holder, a stale heartbeat or an owner-less lock is reclaimed. `status` reports each PR's next action,
  checks, verdict and whether it sits on its parent, and an overall
  READY/WAITING/ADVANCE/COMPLETE. `sync` restacks after a (squash) merge with
  `git rebase --onto <parent> <last parent tip>` in the branch's own worktree
  or a temporary one under the store (never the user's checkout), refuses
  branches with merge commits, and pushes only when the moved branch is the
  same change (exact diff, no dropped commit; else `blocked`
  `content_changed`, the rebase kept local, `--force <branch>` to push it). It pushes
  through the S11 lease and retargets PR bases; a conflict stops `blocked`
  with the rebase left in progress and the unblock, processed branches
  recorded and the rest untouched. Each restack records an observed
  `stack.restacked` row; when the change against its parent is identical
  (patch-id and exact diff hash), S13 carries the verdict through it (CI is
  never carried; agent-written rows never count). `land` merges only the
  contiguous run from the root whose PRs still belong to their branch and
  head repository (and the planned repo), target the trunk, read READY and
  have an accepted verdict, one at a time through the `pr merge` gates
  (which re-check the base); after each merge it restacks and retargets the
  next PR and waits for its CI, and stops at the first PR that does not
  qualify with the reason (`--dry-run` mutates
  nothing; `--max`). `pr status` gains a `verdict` block.
- `workit git branch|commit|push`, `workit pr create|merge` and
  `workit verify-delivery` (S11). `git branch` checks the name against the
  workspace branch policy and branches from the freshly fetched default target
  (a local unprotected branch is a stack parent); dirt outside `docs/` needs
  `--carry`. `git commit` refuses protected branches, lints the subject
  against the commit convention (`auto` follows the history), commits only the
  index, the named paths or `--all`, and writes a `Workit-Session:` trailer
  plus an observed `commit.recorded` ledger row for S13's author check.
  `git push` refuses protected branches, checks the forge account (S10
  credential), pushes the exact SHA (no follow-tags, no submodule pushes),
  forces only with `--force-with-lease` leased on workit's own last real
  push (`push.verified` with `pushed: true`; no-op pushes are `push.noop`;
  never the tracking ref; otherwise `--expect`), plus `--force-if-includes`
  semantics even with `--expect` unless `--overwrite-unintegrated`, and records `push.verified` only when the
  remote tip equals the local SHA. `pr create`
  binds the pushed SHA, reuses an open PR/MR, post-verifies the forge head and
  records `pr.created`. `pr merge` needs `pr status` READY, an accepted
  independent verdict for that head (under any merge grant; `merge: true`
  also allows a recorded `--unverified --reason` bypass) and the merge grant; it merges with the forge's head-SHA
  guard, deletes the branch under a lease (never a protected branch, the base
  or the default target) and records `pr.merged`.
  `verify-delivery push|pr|merge|release` observes the remote (branch tip,
  PR head, merged state and merge commit on the base, tag and npm version,
  with the published gitHead required to match any expected commit; package
  specs must be npm names with exact semver)
  and exits 1 when it did not land. Autonomy grants are read from the
  workspace's `autonomy` entry in user config (`requireGrant`); an absent
  grant falls back to the host's own permission until S16. The PR body issue
  linking moved to `forge/pr-body.ts` (`core/pr-create.ts` re-exports it), and
  the managed `hosting.delete_branch` action shares the lease deletion.
- `workit pr status`, `workit ci wait` and `workit ci rerun` (S10). One
  forge-neutral status document for GitHub (`gh api graphql`) and GitLab
  (`glab api`): mergeability, conflicts, required rebase, behind-base counted
  locally against the API's base tip (fetched by id, no ref moves), required
  vs optional checks (GitHub `isRequired`, branch protection and rulesets;
  GitLab jobs, bridges and the pipeline status as a floor, merged-results
  pipelines included), redacted failing job logs centered on the first error,
  unresolved review threads, merge blockers, and a `next` action (conflicts >
  rebase > threads > CI > review > draft > merge queue > other blockers).
  `ci wait` polls with a deterministic backoff under one hard deadline and
  exits 0/1/3/4; `ci rerun` reruns failed jobs once per (PR, head, check)
  unless `--force`, under a lock, recorded in
  `<git-common-dir>/workit/ci-reruns.jsonl`. The forge comes from the push
  remote (fork PRs live in the parent), every call carries the workspace
  account's credential, and a disagreeing provider or account is `blocked`.
- Action-time `cwd` targeting for Git and hosting actions from a task rooted in
  any directory, including a non-Git OS workspace; no related-repository list
  is required. Cross-checkout actions hold target writer serialization through
  settlement; branch proposals bind the local and remote base SHAs, and quoted
  shell text cannot spoof a directory change. Hosted `hosting.pull_request` is
  enabled with pre/post provider SHA verification (the residual non-atomic
  source-SHA race is accepted, decision `ae03c569`). `hosting.delete_branch`
  requires a live tip matching an already merged PR/MR head and rechecks it
  before deletion. Hosted merge rechecks its target immediately before the CLI
  call, with the provider's lack of an atomic target precondition recorded as
  an accepted limitation.
- OpenCode V2 dual entry: one `@brainervirus/workit-opencode` artifact serves
  V1 `server()` (floor raised to `1.18.30`) and V2 `2.0.3` `setup()` with the
  exact ten tools (`codemode: false`), fourteen method skills and `wk-*`
  commands with user collisions preserved, question receipts consumed once by
  `decision.record`, direct-child subagent lineage with durable dispatch
  claims and bounded reconciliation, shell route and worktree denial through
  `permission.evaluate`, bootstrap/task/worker context and compaction
  injection, and layout-stable asset resolution for source and bundled
  installs. Docker matrix lanes (V1, V2-native, V2 V1-shaped) run against one
  packed artifact.
- Workspace opt-in auto-approval: `autoApprove` classes plus `vcs.account`
  in `workspaces.json` let covered branch, commit, push, PR, and merge
  effects execute with no question, each still recording a reservation with
  its exact binding. Standing approvals re-validate live (removal restores
  questions instantly, imported standing receipts are dropped). Guardrails
  are code: effective CLI identity must match the target area's configured
  account and provider-side branch protections apply; publish/release stay gated. New
  `hosting.merge` action (squash + delete branch per config) with the same
  protections, and raw `gh pr merge` / `glab mr merge` route into it.
- Concise native action approvals: a mutating action call that has no approval
  returns `needs_input` with a short user-facing proposal (`presented`,
  `approvedContent`, `descriptorDigest`) while the canonical descriptor stays in
  tool state; `decision.record` stores the exact descriptor plus the approved
  display text, and Pi/CLI confirm the same concise summary. Oversize Workit
  binding questions are rejected with show-first guidance — before display on
  OpenCode and at record time elsewhere — and near-miss failures name the failed
  receipt element instead of only "no match".
- Plan-scoped commit approvals: `git.commit` accepts `plan_steps`/`plan_branch`
  and records one approved commit list; each listed commit then executes once,
  in order, without a new question, while unlisted messages, branch or checkout
  mismatches, and replays still require a fresh exact approval.
- Show-before-ask guidance shipped in the invariant bootstrap and `workit-plan`:
  present durable artifacts as a complete digest plus exact path (inline plans as
  their content) before any binding question, keep questions to one scoped
  sentence, treat custom answers as steering rather than approval, and execute
  an approved plan continuously with one atomic commit per task.
- Runtime metadata: task and workspace records carry
  `runtime.createdWith`/`runtime.updatedWith`; summaries expose it, imports
  preserve the source creator, and legacy records are stamped truthfully on
  their next mutation.
- Protocol ergonomics: revision conflicts teach omission with current
  revisions, `task.close.decisionIds` is optional and closure derives its own
  references, `requirements_unsatisfied` reports each blocking rule with its
  reason and satisfaction text, `writer.acquire`/`writer.release` both accept an
  optional reason, escaping scopes and document refs explain the linked-task and
  `file://` alternatives, placeholder policy actions are gone, and summaries
  carry deterministic timestamps and blockers.
- Host truthfulness: OpenCode, Pi, Codex, and Cursor declare an honest
  `fresh-context-review` capability instead of implying independence, and the
  OpenCode stale-source marker resolves the real core sources.
- Branch setup truthfulness: `target_branch` is required for `setup` and names
  the working branch, the proposal binds `base_branch`, `target_exists`,
  `remote_base`, and `dirty`, proven preflight failures return `not_started`
  without touching HEAD/index/stash/manifest, and only target, base, remote
  base, or existence moves after approval require a new resolved proposal —
  unrelated HEAD or dirt moves re-resolve under the same approval, and a
  dirty tree binds `stash: "yes"` into the proposal so one approval carries
  the stash through.
- Structural approval validity: action approvals are content-bound, never
  clock-bound — an aged approval revalidates when a fresh resolve produces
  the identical descriptor and only genuine repository drift fails closed
  (naming the moved element); re-resolution returns the existing pending
  proposal instead of minting duplicates; and a user-stated choice records
  as a `stated` decision that retires product decisions without authorizing
  mutating actions.
- Single chain reservations: a plan list may mix `{branch: name}` and
  `{pr: true}` steps with commit messages under one approval, executed once
  each in order against a history lease (rewrites invalidate the chain);
  branch-owned spec/plan docs under `docs/` ride onto a new branch while
  other dirt binds `stash: "yes"` up front; one binding/pin/verify core
  serves every call site with canonical-JSON ref comparison.
- Explicit singular revisions: every task mutation takes `expectedRevision`
  (plus `expectedWorkspaceRevision`), exports/imports round-trip through the
  schema with a single resume path, worker cancel is idempotent and
  lead-attested, and the lifecycle gate table splits pause blockers from
  resume/close/revise blockers. Policy gates are enforced, never advisory:
  `before:write` blocks `writer.acquire` while unsatisfied, close blocks
  only on `before:close`, and unsatisfied reasons name the expected evidence
  kind.
- Self-identifying runtime: local-dist stale-install detection compares the
  installed bundle hash against the current build (same version, different
  bytes fails), and the ephemeral-cache path table lives in one core helper
  instead of per-callsite substring lists; the branch-setup stash upgrade is
  one core helper with one-line adapter callers.
- `workit youtrack show <ISSUE> [--json]` and `workit youtrack create --project --summary` (create needs `WORKIT_YT_WRITE=1`, now also required for note, time and meeting).
- `workit config show [--json]` prints the effective config here and where each value comes from; `workit grant show` prints `vcs.provider`. Guessed verbs get a did-you-mean (`workit commit` → `workit git commit`).
- `workit doctor` has a YouTrack row when a workspace uses YouTrack: ok when ytrack is logged in to each configured host; a warning naming `ytrack auth login --host <host>` when it is not; a deprecation warning when Workit falls back to the legacy token file.
- `workit uninstall` can remove the Workit CLI itself (pick "Workit CLI"): the PATH launcher link, `bin/`, `current` and `versions/` under the Workit data dir. A foreign file at the launcher path is left untouched and reported (W2.32).
- `workit issue view|comment|close|create` works on the workspace tracker (GitHub or GitLab) under the `pr` grant, so agents close and comment on issues themselves; `workit finding record --queue` files a finding as an issue (#439).
- A fanout slice that depends on another is created as a stack: its worktree branches from the parent slice, `fanout status` shows the stack, and `workit stack sync` rebases a child onto trunk without the parent's commits once the parent is squash-merged. `stack land --others-pr --reason` lands another author's PRs like `pr merge` (W2.37).
- Shell completion: `workit completion zsh|bash|fish|powershell` completes verbs, subcommands, flags and live values (configured check names, workspaces, fanout slices) from the verb registry. `workit setup` and `workit upgrade` install it for your shell under the XDG data/config dirs and print the zsh `fpath` lines when needed; your rc files are never edited, and `workit uninstall` removes only the scripts Workit wrote.
- `workit help` and per-verb help are coloured at a terminal (bold headings, accent commands and flags, dim descriptions); plain under NO_COLOR, TERM=dumb, CI, a pipe or `--json`.
- `workit fanout brief <slice> --host <host>` renders the brief for the worker's host (model lines, attribution); with WORKIT_HOST unset, `cli` or misspelled, a warning names the valid hosts (#292).
- `workit pr merge --allow-failing <check> --reason <why>` merges past a failing optional check (never a required one), recording a `merge.waived` row (#269).
- `workit stack land --allow-failing <check> --reason <why>` lets a failing optional check through on each PR it lands (one waiver row per PR), and stack land re-reads a PR whose mergeability is still being computed, through the same gate as `workit pr merge`.
- `workit git rebase [--onto <base>]` updates the current branch onto its freshly fetched base, aborts cleanly on a conflict and names the paths, records the rewrite and prints the `workit git push --force-with-lease` next step; the ship skill uses it instead of a raw rebase.
- The local weak-model bench runs its cases on OpenCode (`--host opencode`, DeepSeek 4.1 Flash on the free provider, then go when the free limit hits), records the provider per case, and records a case skipped (limit) when both are limited (#488)

### Changed

- `workit stack land` checks every PR before merging any: when one would be refused (verdict, required check, another author, base, mergeability), nothing merges and every refused PR is named; `--max N` lands just the first N. `--allow-failing` applies only to the PRs whose head runs that check.
- Verdict gates and stack carry checks compute a range's patch-id and diff hash from one git diff instead of two.
- Workit runs fewer git processes per command: a checkout's top level, git dir and common dir are read once per process, and the default base is found with one git call instead of one per candidate branch (faster on Windows especially).
- Releases no longer open a manifest-sync PR to main, so a release never makes open PRs fall behind; main keeps its last-synced versions and the release job sets the real version before publishing (a guard refuses to publish on a mismatch).
- New managed worktrees go under the state dir (`~/.local/state/workit/worktrees/<repo>/<slug>` on Linux and macOS) instead of `~/.cache/workit-wt`. Existing ones are never moved: cleanup and `workit gc --worktrees --apply` still sweep merged ones there and remove the old dir once empty; `workit doctor` (`legacy_dirs`) reports it until then.
- A repo's `.workit/` now holds only committed team config (`checks.json`, `risk-paths`): it no longer ignores itself, and the task store writes nothing into a git checkout's `.workit/`. Old leftovers there (2.x markers, `tasks/`, `workspace.json`) move once into `.git/workit/legacy/` with nothing deleted but exact Workit markers.
- Every Workit file location now comes from one resolver: XDG on Linux and macOS (`~/.config/workit`, `~/.local/state/workit`, `~/.local/share/workit`, `~/.cache/workit`), `%APPDATA%\workit` for config and `%LOCALAPPDATA%\workit` for the rest on Windows. On first run, macOS state moves from `~/Library/Application Support/workit` and Windows config from `~\.config\workit`, leaving a `.moved-<time>` marker; `workit doctor` reports it (`legacy_dirs`). See docs/agents/file-locations.md.
- **Breaking:** the remaining `WORKFLOW_*` env vars are now `WORKIT_*` (for example `WORKIT_WORKSPACE_ROOT`, `WORKIT_WORKSPACE_NAME`, `WORKIT_YT_WRITE`, `WORKIT_VCS_CONFIG`, `WORKIT_RELEASE_TRACK`); the old names are ignored.
- **Breaking:** only the name Workit remains. The `WORKFLOW_TOOLKIT_*` env vars are now `WORKIT_CONFIG`, `WORKIT_CONFIG_DIR`, `WORKIT_STATE_DIR`, `WORKIT_DEV` and `WORKIT_REPO`, and the old names are ignored. Old `~/.config/workflow-toolkit`-style folders are no longer migrated; move them by hand.
- Codex: the plugin is now `workit@workit`. `workit setup` and `workit upgrade` move an install off the old marketplace name with Codex's own commands, so the hooks never run twice; re-trust them in `/hooks` afterwards.
- The CLI installs into a Workit-owned directory (`~/.local/share/workit/versions/<v>` with an atomic `current` link and a `~/.local/bin/workit` launcher that finds a Node 24+ itself; Windows: `%LOCALAPPDATA%\workit\install`), so it no longer depends on which Node version manager prefix a shell sees (#648).
- Grant and workspace confirmations are a single-key y/N at the user's terminal instead of typing the workspace name; `workspace rm a b c` confirms once; the overlap warning names only entries whose globs really intersect (#656).
- `workit doctor` runs each installed hook launcher once in the current repo and fails `hook_node` when one cannot answer; `hook_runs` warns when a host's newest hook run failed. See docs/guides/troubleshooting.md.
- Claude Code accepts full model ids such as `claude-sonnet-5-5` in `models.roles` (applied as their alias) and warns about a value it cannot apply instead of silently dropping it.
- Claude Code: Workit strips worktree `isolation` on every Agent spawn, not only `workit:implementer`.
- Close-time testing and verification gates accept only a fresh, passing,
  CLI-observed run of a configured check (or an approved limitation): `testing`
  binds to `test` (or `gates.testing`), `verification` to the configured
  checks. Agent-recorded checks stay recordable as notes but no longer satisfy
  them, ad-hoc `workit check -- <cmd>` runs never do, and RED-first no longer
  applies. A check that changes the worktree is stale. Per-turn host context
  judges freshness from a cheap stat-cached signal and never hashes the tree.
  A task holding an observed check lists the observation as a critical field,
  so older Workit readers fail closed on it.
- **Migration for in-flight tasks:** a task whose testing or verification gate
  was satisfied by agent-recorded checks reads unsatisfied after upgrading.
  Run the repo's configured check with `workit check test` (or `npx -y
  @brainervirus/workit-cli check test`), adding `workit.checks.json` when
  nothing is detected, or record an approved limitation where the requirement
  allows one.
- OpenCode V1/V2 remove managed external mutations and proposal/approval
  orchestration. Native host tools execute effects; strict read-only
  `workit_context` replaces the old combined action/context tool. Existing
  history and remaining-host action machinery are preserved.
- GitHub/GitLab setup, doctor, issues, PRs and merges now use the authenticated
  `gh`/`glab` CLI rather than separate Workit VCS tokens; existing token files
  remain untouched. User-selected Git-valid branch names and commit messages
  are no longer rejected by Workit formatting rules. Doctor checks the
  configured provider's CLI/SSH identity, and hosting API reads bind to the
  resolved push host. YouTrack still uses its permanent token.
- Package payload changes now cut a patch release even when their commit type
  is `docs` or `chore` (skills and metadata live in the tarball, so installed
  users must receive them); the release's own manifest sync is excluded and
  merge-backs of already-released payloads stay unreleased.
- `workit-steer` pauses the parked lead task before starting a new one (one
  active lead per session keeps external-action writer authority unambiguous),
  and `workit-babysit` re-records verification and review evidence after a
  squash merge, when the pre-merge candidate identity changes.
- AGENTS.md maps where agent-facing rules live (invariant bootstrap, method
  skills, adapter messages, repository docs) so future fixes are proposed for
  the distributed surface first.
- Repository and package metadata now use v1 wording and search-friendly
  keywords; the GitHub About gains description, homepage, and topics so the
  project and its packages index better.
- The repository README opens with a per-tool install guide (collapsible
  sections for OpenCode, Cursor, Codex CLI/desktop, Pi, and the CLI) and a
  dedicated host-surfaces section.
- `workit-challenge` is now a grounded grill loop: ground-first facts, one
  bounded 3-5 direction diverge burst when the approach is unknown,
  one-question-at-a-time recommendations each with a rejected alternative, a
  receipt funnel that binds choices the moment they resolve, counter-case
  discipline, and the hard three-round cap. A choice already stated without a
  receipt is recorded in progress and reassessed instead of re-asked, so close
  never demands a stale receipt. Durability still comes only from the
  `durable-spec` requirement.
- Arbitrary file writes are host-policy on every adapter: the OpenCode,
  Cursor, Codex, and Pi write interceptors no longer gate tools or shell
  commands on task scopes, and the core product-write check keeps only
  writer, role, and session ownership (path-scope enforcement is gone, along
  with the now-dead shell-intent parser). Managed workit mutations (task
  state, external actions, setup/cutover) keep writer ownership; capability
  reports mark `known_product_writes` accordingly.
- Removed path confinement (`trustedPaths`) across core and all four
  adapters plus the CLI wizard: absolute scope paths are valid and only
  traversal escapes are rejected; writer ownership, role, session, scope,
  and approvals remain the bound. The `trustedPaths` wizard screen is gone
  and the setup preview no longer merges it.
- OpenCode's advertised operation schemas now use bounded provider-safe projections for deeply nested inputs while preserving core-owned validation and the complete eight-family tool surface.
- Cancelling a worker that was assigned but never launched no longer leaves the coordinator blocked with no truthful way out. The core gained two host-only methods, `prepareWorkerDispatch` and `commitWorkerDispatch` (no new operation family, no new serialized field, no caller-supplied receipt): a host claims the launch slot of an exactly-`assigned` worker before spawning, and the resulting in-process reservation is settled exactly once — either `started` with the observed child session, or `not_started`, which records a host-attested `stopped` with a null session. OpenCode prepares in `tool.execute.before` for a native `task` call when exactly one assigned worker is attributable to that coordinator and only claims "never started" when that same task call explicitly proves no child session exists; Pi prepares immediately before spawn on the live handle and only settles "never started" while that same handle proves no spawn was attempted. Ambiguous assignments, generic cancellation strings, missing child metadata, and reservations lost to a restart all stay unresolved and are never inferred to be stopped.
- Releases are now path-gated and selectively published: tooling-only merges cut no release, and npm receives only packages whose payload changed since the previous tag. The publisher diffs against the previous release tag passed by semantic-release (`${lastRelease.gitTag}`) — the new release tag is created before publish plugins run, so diffing against the latest tag skipped every package.
- Repository checks now run lint, format verification, tests, and TypeScript typechecking.
- The OpenCode package now bundles the `@opencode-ai/plugin` SDK surface into its build and pins the SDK as a build-only dependency, dropping the unused transitive `ini@7` install path.
- Raised the Node support floor to 24 across the support matrix, package `engines`, CI, and documentation (the current toolchain requires Node ≥ 24).
- The Cursor README now documents Marketplace and local installation, Node/network requirements, MCP/hook runtime execution, Git/VCS/YouTrack/filesystem interactions, persistent redacted logs, secret handling, `@latest` review drift, update behavior, and troubleshooting; CI runs the Marketplace validator in the Cursor and candidate jobs.
- Two-workspace VCS routing: `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow; resolution order is explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The global `vcs.json` `defaultTargetBranch` is removed from the active config and can no longer shadow a matched workspace's branchPolicy default.
- Legacy `~/.config/workflow-toolkit/` non-secret config files (config.json, vcs.json, youtrack.json, workspaces.json, templates/) were cleaned up once the active `~/.config/workit/` config passed status checks; the runtime reads only the active config dir.
- The complete orchestration tool surface was renamed from `workflow_*` to `workit_*` across both host adapters (OpenCode native tools, Cursor MCP registrations), the shared core strings and mutation allowlist, shipped skills/templates/vendor content, and all tracked documentation. Host-only tool names are unchanged by the rename. Legacy brand strings (`workflow-toolkit`, `workflow_toolkit`, `workflow-toolkit-contract`) are unchanged for legacy-identity detection.
- User-facing surfaces were renamed from `workflow-toolkit`/`workflow_toolkit_*` to `workit`/`workit_*`: the bootstrap contract marker is now `<workit-contract>`, `workflow_toolkit_status`/`workflow_toolkit_init_status`/`workflow_toolkit_init_apply` became `workit_status`/`workit_init_status`/`workit_init_apply`, the share path is `~/.local/share/workit`, and the install-root marker is `.workit-root`; legacy-identity detection and migration from the old config directory are unchanged.
- Installs made before the rename carry a stale `.workflow-toolkit-root` install-root marker that the runtime no longer reads (it falls back to environment/dev paths until then); the next sync rewrites the marker to `.workit-root`, so the transition resolves on re-sync.
- `install-cursor-plugin.sh` gained a `--local-dist` mode that registers node-form MCP/hook launchers against the installed plugin's own built `dist/` (instead of the published npx pin), so a checkout install runs the current branch's code — rename included — without waiting for a release; the doctor accepts this local-dist hook alongside the canonical pin.
- The Cursor runtime selector evolved in one step from an exact reviewed pin (`@brainervirus/workit-cursor@0.8.5`, the latest public at the time) to the `@latest` dist-tag with a mandatory `--prefer-online` flag (`npx -y --prefer-online --package=@brainervirus/workit-cursor@latest …`): `--prefer-online` forces fresh registry re-resolution so a stale `latest` in the `_npx` cache is never reused, the doctor enforces this exact launcher shape, the doctor's negative-rejection fixtures cover near-miss variants, and no per-release manual pin bump is required.
- `install-cursor-plugin.sh` now self-heals stale plugin installs: a `doctor-check.ts cursor --stale` pre-check exits 2 on a `stale_install` failure and the installer then refreshes the plugin directory and rewrites the workit MCP/hook entries to the canonical `@latest` + `--prefer-online` selector, preserving unrelated MCP servers; a registry-unreachable comparison stays fail-open (warn, never stale, never install failure), and a healthy install is byte-untouched.
- Delegated authority is direct-child-only: a worker's host `parentID` must equal the activating coordinator's session handle; mismatched or multi-owner lineage fails closed with `delegation_lineage_denied`, nested `opencode` launches are denied during active delegated work, and authorized children receive only compact worker-only context.
- Fewer needless re-verifications: a clean rebase carries its verdict (judged by replaying the verified head onto the new base), bookkeeping files (changelogs, `write:*`-generated files, version-only manifest changes) never make a verdict stale, and a test-only push keeps a unit verdict at any size. A verifier that lost its token is told how to recover (#312).
- Fanout briefs: light ad-hoc commands run as `workit check --name <n> -- <cmd>` (no lease) and `--heavy` is only for full suites, packaging, builds and knip; hard slices get 180 tool calls and every brief says by which call to run the full gates; briefs print `WORKER: <slice>`; the skills VERIFY line reads the worktree's checks and ignores `docs/agents`.
- YouTrack goes through your `ytrack` CLI when it is installed (token in the OS keyring): Workit never reads its own token file then, passes no token, and a logged-out ytrack fails with `ytrack auth login` instead of falling back. The token-file client stays one release as the fallback when ytrack is missing (#263).
- CI: Windows tests run in 12 shards balanced from fresh timings; spawn- and git-heavy tests share one Windows-scaled timeout helper; fixtures and goldens are pinned to LF by .gitattributes and a test fails on any fixture without an eol rule; docs-only PRs still run the tests that read the docs (#415).
- Implementer instructions agree with the hooks on git: in a Workit worktree use `workit git --cwd <worktree> …`; only a Claude Code host-isolated worktree uses plain git. Implementer definitions and briefs show `workit git commit --trailer "Co-Authored-By: …"`, and Claude Code and Cursor briefs carry the concrete trailer (no invented addresses for other hosts) (#292).
- Verdict gates read HEAD and branch tips from the repository files (fresh on every read, git as the fallback whenever a read is uncertain) and the origin URL once per gate, so a gate check spawns 8 git processes instead of 10.

### Fixed

- An integration-mode fanout brief's fan-in step runs `workit git rebase --onto <trunk>` instead of a raw `git merge`, and a test checks every workit command a brief prints against the verb table (#770)
- `workit stack status` reads a parent whose PR squash-merged as landed (not `no_pr`), and `stack sync` retargets the child PR onto the trunk even when the stack was recorded without PR numbers.
- `workit pr merge` refuses a PR whose short-lived base (a stacked parent or a work branch) already landed and has not moved since (`base_landed`, with the retarget command), and `workit verify-delivery merge` reports delivered only when the change reached the trunk its base landed on (the #752 merge into a stale parent).
- A closed output reader (`workit … | head -1`) no longer logs `uncaught_failure: write EPIPE` or prints a stack trace: the verb finishes quietly with its own exit code.
- A heavy check whose workit process died keeps its machine lease while its command still runs, a recycled process group no longer holds a lease, and a nested check under an orphaned parent reuses the outer lease instead of queueing behind it.
- Tests no longer fail by shard order on Windows: every test file runs isolated (its own env, cwd and globals), tracker reads in tests use an empty config instead of the machine's, and test repos skip git auto-maintenance.
- `workit check` no longer hangs when the runtime loses a command's exit event: once the command's output closes, its own exit status settles the run.
- Verdict ranking: a failure wins a same-time tie with a verdict mirrored from another clone, a future-dated mirrored verdict no longer outranks newer local failures, and author checks use the same ordering. Only real test files (`*.test.ts`, `*_test.go`) keep a unit verdict through a test-only push; `.test.` helpers and fixtures do not.
- A worker report that merely mentions a usage limit no longer triggers the model fallback, and standing orders reach exactly the agent types each host maps to the implementer role.
- `workit check --timeout` now bounds the whole check, including the wait for the heavy-check lease (#645): parallel heavy checks no longer outlive their own timeout; a wait that runs out exits 4 naming the holder.
- OpenCode: a lead can launch several workers at once, and each child binds its own brief (by `WORKER: <id>`, the brief's objective or scope paths, or role) instead of the oldest assignment (#640). A launch that matches several workers is refused, naming them and the `WORKER: <id>` fix.
- Release publishes packages in dependency order with the CLI last and holds back a package whose dependency failed, so `npx @brainervirus/workit-cli@latest` never resolves a CLI whose dependencies are not on npm yet (ETARGET seen on 13.0.0).
- Workers and verifiers no longer stay listed as running after their final report: briefs and the implementer, verifier and reviewer agents now finish or stop every background command they started before reporting, and the fanout skill tells the lead to stop a worker once its report arrives.
- When the Claude Code Agent hook replaces a spawn's model with the configured role model, its note names the model (and effort) to pass next time, so the next spawn needs no rewrite.
- `workit upgrade` verifies the version that PATH actually runs and fails, naming every copy by real path, when another install shadows it; at the user's terminal it backs up and removes old `npm i -g` copies from fnm/nvm/volta/mise/asdf prefixes after a y/N, and only prints the commands in an agent shell (#648, #423).
- The update check never reports a latest version older than the running CLI.
- `workit git branch` no longer leaves a half-created branch behind when `git switch -c` fails; it only removes a branch it created itself, never touches another process's `index.lock` (it prints the `rm` command to run if no git is running), and names a killed or timed-out git instead of a bare "git failed" (#652).
- `workit git branch` refused for a dirty worktree now lists the dirty paths and the exact `workit git branch <name> --carry` command.
- A Workit hook that cannot run (Node below 24 in a repo that pins an older Node, a missing or broken bundle, a crash) is no longer silent on Claude Code, Codex and Cursor: session start, prompt submit and subagent start show the cause and the fix, every event writes a stderr line and a failure row, and tool events still never block the host. A verifier whose SubagentStart hook failed is told its verdict will fail with `no_session`.
- Worktree confinement no longer denies an implementer's own writes written as `W=<worktree path>; touch $W/a`: a plain, unconditional `NAME=value` in the same command is resolved before the path check. Anything that could rebind the variable (`&&`/`||`, pipes, loops, `read`, `eval`, `source`, `declare`, `+=` and similar) keeps it unresolved, as before.
- Worktree confinement now denies a write hidden in a loop body such as `for W in <outside>; do rm $W/a; done`, which was allowed before.
- `workit pr create`, `workit check` and `workit ci wait` print a first line at once (what they check, how long they may take, how to run them in the background), so a host shell timeout no longer kills a silent command (#638). `workit check` also prints a "still running" line every minute.
- `workit pr create` bounds its forge calls (90 s in total) and fails naming the stalled call instead of hanging on the changelog check (#644).
- `workit ci wait` reports success on its first poll when every Actions run on the head passed but the check rollup still shows them pending; a required check that has not posted, or a pending check whose own run is still going, keeps it waiting (#646).
- A relative `--body-file` resolves against the directory you ran the command from, then `--cwd`; a missing file names both paths (#643).
- A verifier's `blocked` verdict no longer sticks once the same session records a passing verdict on the same code, and `workit ledger verdict --supersedes` accepts the `#N` row number that `workit ledger list` prints (#639).
- `workit ledger verdict` run outside a git checkout now says to pass `--cwd <worktree>` instead of a bare "no commit to judge".
- A `changelogPath` glob such as `projects/*/CHANGELOG.md` that matches no
  file in a repo falls back to the root `CHANGELOG.md`, so one workspace
  setting serves both its monorepos and its single-package repos; under
  `create` the root entry is required instead of the check passing silently.
- `workit release notes approve` and `workit grant set|raise` are denied
  (Cursor, Codex, Pi) or asked (Claude Code) by Workit's shell hook however
  `--json`, `--cwd` or `--session` are placed before the verb, closing the
  Cursor prefix-match gap left by #623.
- On macOS a quiet but busy heavy check is no longer marked `stuck?` after
  5 minutes: the heartbeat counts its process group's CPU through `ps`, as
  Linux does through `/proc`. On Windows only output counts as a heartbeat;
  raise `resources.maxHold` in your own config for a long quiet check.
- A stuck heavy check no longer starves every other agent: `workit lock
  status` marks a holder `stuck?` past `resources.maxHold` (default 15 min) or
  after 5 min with no output or CPU, `workit lock reap` frees its slot and
  records it in the ledger, and a holder silent past 3x the limit is reaped
  automatically. `workit lock cancel [<pid|session|dir>]` drops queued checks
  without `kill`; waiters whose starting process ended leave the queue; the
  queue serves sessions round-robin; and a check that gives up says `queued
  behind <holder>, <age>` (#608).
- `workit release notes approve` and `workit grant set|raise` always reach
  the host's permission prompt or a deny: Claude Code (also in auto mode),
  Codex and Cursor get managed rules for them, and `workit upgrade` replaces
  the old auto-mode text. Pi has no permission layer, so only the CLI check
  applies there. The CLI check stops a cooperating agent; the host prompt stops
  a determined one (#615).
- `workit workspace set` points a path-like key such as `path=` at `glob`
  (with the workspaces.json path and `workspace add <name> --glob <g> --from
  <ws>`) and suggests the nearest key for a misspelt one. Hints naming
  `vcs.json` or `workspaces.json` print the file Workit actually reads when
  `WORKFLOW_TOOLKIT_CONFIG` redirects the config dir; the grants note says that
  override never applies to grants (#617, #618).
- `workit uninstall` now also removes Workit pins from the OpenCode 2.x
  `plugins` key (it only cleaned the V1-era `plugin` key, so a 2.x
  registration, including a checkout directory pin, survived uninstall).
- `.workit/recovery/` no longer grows without bound: each task or workspace
  record keeps its newest three recovery copies. `workit gc` (`--dry-run`,
  `--json`) prunes copies left by older versions, removes stale temp files, and
  collapses duplicate stored candidates in paused tasks (closed tasks are never
  rewritten); `--dry-run` is read-only.
- `state.recover` is no longer advertised in host tool schemas or the CLI: it
  requires native recovery authority that no shipped host supplies, so it could
  only return `permission_denied`.
- A `.workit/metadata.lock` left by a dead process (or a reused pid, or a
  foreign-host/namespace lock past its TTL) no longer bricks the store: the next
  write reclaims it. Locks carry the pid namespace and boot id so a container
  sharing the hostname is never judged by this host's process table, and a
  lock from before a reboot is reclaimed at once.
  Contention with a live writer retries briefly (250 ms in-process, 2 s in the
  CLI) and returns the retryable `busy` code instead of `recovery_required`.
  `workit doctor` reports a stale lock (`workspace_lock`); `workit doctor
  --fix-lock` clears it under the reclaim guard, and `--force --yes` clears an
  unverifiable lock explicitly.
- Compact task context retains the newest decisions and surfaces bounded,
  redacted choice summaries instead of selecting an arbitrary UUID-ordered set.
- Distributed cross-repository guidance binds unfinished work to its checkout,
  branch, deliverables and delivery endpoint, preserves explicit holds, and
  verifies the requested remote result before reporting completion.
- OpenCode V2 keeps uncertain subagent dispatches correlated through failed
  terminal-state persistence, retries reconciliation, and lets explicit
  `failed`/`interrupted` session outcomes override conflicting completion text.
- OpenCode omits a Workit slash alias when a user skill owns its matching Workit
  skill ID; the implementation-skill trigger now matches its optional tracking
  guidance across packaged hosts.
- OpenCode action approvals revalidate same-text proposals before rejecting
  ambiguity, so a stale pre-branch proposal cannot wedge a current commit.
- Distributed guidance chooses native tools for routine authorized Git work
  without task/writer/decision ceremony or post-commit PR-readiness escalation.
  Native permissions and managed uncertainty/conflict safeguards remain intact.
- Bounded behavior changes retain behavioral verification and self-review;
  fresh-context review remains required for consequential boundaries, thorough
  preference and explicit project constraints rather than every behavior edit.
- OpenCode worker dispatch now binds only the exact live reserved native task call,
  follows the current coordinator's worker assignment after session resumption,
  authorizes the observed child before its own Workit calls and after adapter restarts,
  persists host-observed completion reports, and denies unmanaged V2 child
  continuation. Native decision receipts and pending action proposals are
  committed only after core persistence succeeds, so revision conflicts remain
  retryable and contradictory V2 answer metadata cannot authorize a decision.
- Standing auto-approval and local external actions follow the workspace's
  current writer session across resumed host sessions, even when other tasks
  are active. Repeated commits and pushes bind their freshly resolved Git
  target instead of request text, while uncertain branch, commit, push,
  hosting merge, and changelog effects use deterministic read-only
  reconciliation before retry; stash reapplication binds and verifies the
  exact stash commit. Fixed findings accept fresh verification of the repaired
  candidate even when the original finding was pinned to the broken candidate.
  Merge recovery rejects older matches while a PR/MR remains open and binds
  explicit source branches to their own commits.
- Task listing defaults to a bounded compact active/paused projection, supports
  explicit bounded closed/all history, and no longer recomputes closed tasks
  against today's checkout or attaches today's writer. `task.inspect` defaults
  to summary, closure retains the exact final candidate even when it repeats an
  earlier candidate, and ordinary paused tasks resume without imported-task
  authority references.
- Mixed plan reservations accept their documented typed branch and PR steps at
  the public schema boundary; action help lists the complete chain and context
  shapes, and worker scope denials identify both conflicting scope fields.
- Development stale-source detection recursively covers all OpenCode adapter
  and shared-core TypeScript sources; V2 now emits the same one-time fail-open
  restart warning as V1.
- Plan reservations under standing auto-approval: `git.commit` with
  `plan_steps`/`plan_branch` records the listed chain and returns
  `plan_commits` with no question on OpenCode, Pi, and CLI, instead of
  failing as a single commit requiring a message. One shared core helper
  backs all three hosts with a parity test.
- Worker and evidence transitions: a reviewer may record supporting checks and
  its review from one independent session (creator and other review sessions
  stay excluded), evidence auto-binds the current candidate before worker pin
  validation, a late child-start observation keeps `cancelling` instead of
  returning to `running`, one shared uncertain-worker set backs
  close/revise/resume/replacement checks, and pausing preserves progress while
  storing the pause reason separately.
- Durable worker launch claims: `prepareWorkerDispatch` persists the
  `dispatching` state inside the lock-guarded prepare mutation, and only the
  live reservation settles it as `running` with an observed child or `stopped`
  with host-attested proof that no child started. Generic errors, cancellation
  text, missing metadata, interruption, and restarts leave the claim
  unresolved, blocking replacement, closure, and resume until reconciliation.
- OpenCode denies a fresh native `task` launch when the coordinator owns an
  active Workit task but has no attributable assigned worker, or when a prior
  launch is still unsettled; native task use outside Workit coordination stays
  unmanaged.
- Narrow shell route enforcement: recognized direct branch creation
  (`git switch -c/--create`, `git checkout -b/-B`) and PR creation
  (`gh pr create`, `glab mr create`) are denied with the exact Workit action on
  OpenCode, Codex, and Pi only while an active or paused Workit task exists in
  that checkout; elsewhere the same commands pass silently. Unparseable or
  unrelated commands stay explicitly unenforced, and every host copy of
  `workit-babysit` tells the agent to drive a PR observed from a route Workit
  did not enforce.
- Auto-babysit on PR creation: `hosting.pull_request` success now carries a
  visible `next` directive (drive mode default, `workit-babysit` skill) unless
  declined with `babysit:false`; the skill declares its mode in the same turn
  and records a frontier brief in task progress per pass.
- Reviewer worker assignments with no requirement ids now fail at assign time
  on assessed tasks and return the review requirement ids, instead of letting
  the worker discover later that its evidence is rejected.
- The pre-PR deslop gate: behavior and mechanical-low-risk assessments now
  add a `pre-pr-cleanup` requirement that gates `hosting.pull_request` (and
  close) until a fresh passing deslop check is recorded or the user approves
  a limitation waiver. Enforcement lives in core (`reserveAction`), so
  OpenCode, Cursor, Codex, Pi, and the CLI block identically; the method
  registry routes `workit-deslop` whenever the requirement is present, and a
  failed reservation leaves the approved action retryable.
- Knip dead-code and unused-dependency gate pinned at 6.35.1 (`bun run knip`)
  with a triaged baseline and an Ubuntu CI job reusing installed dependencies.
- `workit init` writes the vcs provider explicitly (env override, else the
  checkout's origin remote; omitted when neither resolves) so fresh
  checkouts never inherit a silent default. An unconfigured provider is an
  explicit state: `vcsConfig` resolve reports `provider: null` (branch
  policy still resolves from presets) while credential loads fail closed.
  Token-creation URLs preselect nothing without a configured provider, and
  the setup wizard defaults to Skip (configure later) instead of gitlab —
  including per-workspace entries, whose `vcs` section is omitted on skip.
- `wk-*` slash aliases for all fourteen method skills on OpenCode, Cursor,
  and Pi (replacing the five bare aliases); Codex documents `$workit-*`.
- `commitPolicy` config (conventional, gitmoji, ticket-prefix, freeform,
  custom pattern, auto-detect from history) enforced at the `git.commit`
  gate with fail-closed rejections that name the expected flavor.
- Close enforces RED-first ordering on testing requirements: a testing
  requirement with GREEN evidence but no preceding RED failure stays
  unsatisfied, closing the code-then-tests loophole; the behavioral-TDD
  skill text mirrors the rule on all hosts.
- Spec-only docs: GitHub + GitLab issue reads (`docs/trackers/spec.md`,
  read-only title/body/state mirroring YouTrack) and a parallel-delegation
  proposal (`docs/parallel-delegation/proposal.md`, disjoint-scope fan-out
  with single-writer lead mutations — deferred to 1.1.0).
- `context.read` gains `github_issue` and `gitlab_issue` kinds returning the
  same read-only title/body/state triple as YouTrack: GitHub reuses the vcs
  `github.tokenFile` bearer pattern with `gh` issue-ref parsing, GitLab uses
  the vcs `gitlab.tokenFile` `PRIVATE-TOKEN` pattern with full-path project
  resolution (subgroups kept). Both fail closed without a token, the CLI
  wizard offers a GitLab Issues tracker, and Cursor/Codex expose both as MCP
  resources (`workit://context/{kind}`).
- Token files are workspace-tight: a workspace `vcs.tokenFile` wins over the
  global provider file so per-area accounts never collide. Issue reads prefer
  the native CLI (`gh issue view`, `glab issue view`) when installed —
  per-directory identity comes free — and fall back to the workspace-scoped
  token. YouTrack stays token-only (no CLI exists).
- The doctor reports a `github_identity` warning when the checkout's own
  GitHub surfaces disagree (gh CLI login, vcs token-file login, SSH login),
  so operations can never silently land under the wrong account. Only the
  login names are reported, tokens never appear in output, every probe fails
  open, and no accounts are hardcoded — alignment stays in your own git/gh
  configuration.
- `commitPolicy` per-workspace override in `workspaces.json` (workspace wins,
  else global), resolved through `resolveCommitPolicyFor` at the `git.commit`
  gate.
- `workit-challenge` added to the bootstrap moment-based skill routing so
  ambiguous proposals trigger it without an explicit alias call.
- v1 pre-close batch: deterministic spec triage (`triageTier`/`triageSignals`
  with Large/Medium/Small tiers plus recorded override), five bare slash
  aliases (`/challenge`, `/babysit`, `/implement`, `/plan`, `/debug`) on
  OpenCode/Cursor/Pi with `$workit-*` documented for Codex CLI, auto-start
  PR babysitting (`hosting.pull_request` `babysit?` flag, default on) that
  merges per `pr` settings after green, seven new method skills (babysit,
  blast-radius, deslop, diagram, mockup, green-run, steer) with upgrades to
  debug/review/challenge/plan/behavioral-tdd, spec-template tightening
  (Change line, SHALL/GIVEN-WHEN-THEN, skip marker, review checklist),
  `context.read` YouTrack bodies (summary plus description, fail-closed),
  and `scopeCovers` trailing-slash normalization.
- Validation fix program: the CLI documents and implements `workit <family>
<action>` (help, READMEs, contract, pinned help test), `workit writer
acquire --actor <id>` binds a writer to a Codex session the hook matches,
  and `workit_init_apply` is registered on OpenCode with the `branch_policy`
  action. Cutover failures are loud (unknown hosts, malformed resolutions),
  rollback parses flags anywhere, apply honors `--json`, and the uninstall
  picker covers all four hosts. Both hooks share one fail-closed shell parser
  with symlink resolution, the Cursor preToolUse matcher covers the guard set
  with doctor drift detection, and hook attestation no longer claims unsigned
  input.
- The CLI setup wizard now auto-detects installed hosts: detected OpenCode and
  Cursor installs preselect on the platforms screen, existing workit
  registrations are tagged "already configured", and detected Codex/Pi point at
  `workit cutover`. Detection is presence-only (CLI on PATH or home config
  marker, never a subprocess probe) via the shared `detect-hosts` core module.
- Acceptance fixtures, observable-action judge, 90-run evaluation plan, adapter
  capability matrix generator, and stable-release gate for Workit v1 qualification.
  Deterministic CA-31/CA-32 checks run in `verify:release-candidate`; the live
  batch remains behind explicit authorization (`docs/workit-v1/qualification.md`).
- Candidate capture now uses Git's ignore-aware inventory in Git workspaces,
  avoiding recursive scans of ignored dependency and build trees while keeping
  tracked files, relevant untracked files, and staged deletions visible.
- Codex CLI and desktop integration with a native plugin manifest, shared MCP
  transport, documented SessionStart/PreToolUse/subagent hooks, and separate
  CLI/desktop qualification records. Unsupported receipts and writer delegation
  remain explicitly unavailable.
- Optional external-action wrappers now bind concrete host-owned Git, hosting,
  YouTrack, time, and documentation effects to the exact canonical
  operation/target/payload approved by one native action decision, and preserve
  uncertain remote outcomes. OpenCode/Pi use native receipts, the CLI exposes
  an interactive TTY confirmation route, and caller-unattested MCP mutation
  requests remain unavailable.
- Added the read-only `context.read` surface for git/PR/YouTrack/changelog,
  release, and affected context across native adapters and the CLI, plus
  equivalent Cursor/Codex MCP resources. Context reads require no approval or
  writer and do not mutate the checkout or Workit metadata. Release reads now
  include a deterministic Markdown draft; affected reads identify files while
  edits remain existing writer/scope-guarded native actions.
- Pi v1 native extension with the stock package manifest, eight shared
  operation tools, seven canonical method skills, native session/compaction
  continuity, and truthful UI/trust/sandbox capability boundaries. The bundled
  coordinator now supervises fresh stock-Pi reviewer/investigator processes and
  explicitly scoped implementers with observed lifecycle and uncertain
  cancellation boundaries. A child-disabled `workit_worker_control` host
  orchestration tool does not expand the eight shared core families.
- Cursor v1 now uses the shared MCP transport, one documented native hook
  executable, and exactly seven canonical adaptive method skills. AskQuestion,
  session-start/compaction, subagent stop identity, arbitrary shell writes, and
  Tab edits are reported with their actual policy-only or unavailable assurance.
- OpenCode v1 integration now exposes the eight shared Workit operation tools,
  native receipt/lineage hooks, compact task continuity, and only the seven
  policy-selected method skills; the plugin build targets OpenCode 1.18.30.
- Added the shared `@brainervirus/workit-mcp` low-level transport for the eight
  core operation families, with trusted native context boundaries and
  host-specific activation left to the adapter tasks.
- Workit CLI task control over all eight shared operation families and 24
  schema-owned actions, with inline/`@file`/stdin payloads, exact `--json`
  Results, headless consent handling, and read-only `workit handoff --task`
  export plus compact destination context.
- Interactive `workit uninstall` CLI command: a TTY-only host picker (OpenCode/Cursor) with a reviewable action summary before any mutation; it applies the exact inverse of setup's registrations for the selected hosts only — unselected hosts and `~/.config/workit` are preserved byte-for-byte, malformed host files fail untouched, and exit codes are 0 ok / 1 partial failure / 2 non-TTY usage.
- Added an approved reliability-overhaul specification with full requirement, audit, and Ponytail traceability.
- Added pinned Oxlint and Oxfmt checks for first-party TypeScript and package metadata.
- Per-workspace branch policy (`workspaces.json` `branchPolicy`) with git-flow-style detection init and `integration: pr|merge` in the core and the CLI wizard (host init surfaces pending).
- Added a `validate:cursor-marketplace` gate that validates the tracked Cursor Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, skill/rule frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).
- Added verbatim snapshots of the current official Cursor `plugin.json`/`marketplace.json` schemas with retrieval provenance.
- The doctor gained a `stale_install` finding on the Cursor/CLI hosts that detects plugin auto-load rot before it breaks features: legacy `--package=` pins in the plugin's own `mcp.json`, a sessionStart hook running a legacy selector, or a local-dist install behind the current/published runtime all surface with the exact repair step; canonical `@latest` installs never fail on version metadata (the selector resolves fresh at launch), and the sole network probe (the npm registry) fails open as a `registry_unreachable` warning — never a false `stale_install` and never a hard doctor failure.
- The release pipeline now syncs every tracked manifest (root, four platform packages, Cursor plugin manifest) to the released version through an auto-merged PR after each publish, ending the committed-version vs git-tag drift; the root workspace is renamed `workflow-toolkit` → `workit` and pre-aligned to v0.8.9.
- Cursor subagent execution now uses documented native `subagentStart` and bounded product-write hooks. AskQuestion, compaction/session-start continuity, exact subagent stop identity, arbitrary shell writes, and Tab edits remain truthfully marked policy-only, agent-guided, or unavailable where Cursor cannot attest them.
- Native decision receipts recognize the binding question semantically: host
  label qualifiers such as `(Recommended)` normalize for comparison while
  original bytes stay in the receipt, the rejected option description is
  presentation-only, and matching searches the session queue so a newer
  unrelated same-purpose receipt cannot shadow a valid match. Freshness uses an
  injectable clock, and the no-receipt failure now says not to re-ask: record
  the settled choice in task progress and reassess so the requirement retires.
- Policy-selected methods are projected through the shared compact task context
  on every OpenCode agent-loop call instead of only the first, and Pi's separate
  method rendering is removed.
- A worker that may still be `dispatching` blocks every closure outcome and
  resume reconciliation until its launch claim settles or host evidence
  resolves it.
- Cursor's canonical `npx` launcher now carries `--min-release-age=0` so npm's
  open `npx` exclusion bug cannot select an older cached Workit release despite
  the user's `@brainervirus/*` release-age exception.
- External changelog actions canonicalize the workspace root before deriving
  their approved relative path, so macOS `/var` → `/private/var` aliases and
  other symlink-spelled roots no longer look like escapes.
- Preflight failures now surface a failed external-action settlement instead
  of hiding it behind the original provider error and leaving a reservation
  blocked without recovery guidance.
- Codex workspace-root tests compare canonical roots, matching the runtime on
  macOS and other platforms with path aliases.
- Mechanical `self-review` requirements now accept the lead's fresh review
  evidence on every host. Independent reviews correctly reject the task creator's
  session even when it has not recorded any other evidence.
- Init always shows Codex and Pi status and separate setup guidance, clarifies
  that Apply configures only OpenCode/Cursor, and reserves cutover guidance for
  legacy migration.
- Doctor `stale_install` now detects when OpenCode's frozen npm `@latest`
  package cache (`~/.cache/opencode/packages/@brainervirus/workit-opencode@latest`)
  lags the published `@brainervirus/workit-opencode`. Bare / `@latest` pins
  are compared (exact `@version` and `file://` checkout pins are not); registry
  unreachable stays fail-open as `registry_unreachable`. Fix text names the
  cache directory to delete so the next OpenCode launch re-resolves.
- Published `workit init` OpenCode registration pins `@brainervirus/workit-opencode`
  instead of a fragile `file://` path into the pnpm dlx/`_npx` cache. Checkout
  installs still use `file://`. Doctor fails cache-path pins and only requires
  the active `vcs.json` provider token (GitHub-only no longer fails on a missing
  unused `gitlab.token`). Cursor plugin install now materializes a real
  directory under `~/.cursor/plugins/local/workit` when the adapter root is a
  pnpm symlink (previously `cpSync` left a cache symlink); doctor fails that
  fragile shape. MCP/hook launchers were already the canonical
  `@latest` + `--prefer-online` form.
- Post-release manifest-sync branches (`chore/manifest-sync-v*`) are deleted
  automatically after the sync PR merges. Deferred auto-merge was leaving those
  heads on the remote even with `gh pr merge --delete-branch`.
- Init project setup now defaults to No and `n` advances without adding files.
  Locale and timezone selectors scroll beyond five rows, preserving the current
  value instead of silently clamping English to `es-AR`.
- Binding approval questions repeat the `Workit decision: <purpose>` label in
  the question text, so host UIs that do not render headers still show what is
  being approved. The rule ships in the invariant bootstrap (all hosts), the
  challenge skill, and adapter messages, not only in repository docs.
- GitHub release notes now render breaking changes and features: the release
  pipeline loads the `conventionalcommits` preset (the angular default silently
  dropped `!` headers), and the v1.0.0 release body was backfilled.
- Clean-checkout CI builds, packs, and typechecks again: the Cursor MCP entry
  imports the shared transport's source subpath (matching the Codex launcher)
  instead of its gitignored `dist`, the Cursor build skips the in-place
  command-alias copy (Bun 1.4 `cpSync` rejects identical source and
  destination), and the check jobs fetch full history and run the declared
  Node 24 runtime so revision-range and doctor tests behave.
- Worker lifecycle observations that change nothing (same state, same
  session, no writer side-effect) no longer rewrite the worker entry or bump
  task revisions. Hosts observe on every session event, so the old
  rewrite-per-event storm invalidated the revision each call returned and
  worker sessions could never chain two calls (e.g. a reviewer could never
  record review evidence). Genuine transitions still mutate.
- The deterministic Ink TTY harness now drains Ink's lone-ESC disambiguation
  timer (~20ms) at every key boundary, so ESC-cancel races in wizard
  back-navigation tests are gone; `burst()` remains for atomic ESC-prefixed
  sequences.
- OpenCode Workit bootstrap and method skills now require `task.start` then
  `policy.assess` when `task.list` is empty, so ordinary product/debug work no
  longer skips Workit because no policy rule was pre-selected.
- Bind spec/plan approvals to exact-byte SHA-256 digests so edited documents invalidate stale approvals and require fresh reapproval; reject recursive handoffs; and restrict subagent-driven reminders and interception to active execution.
- OpenCode development installation now pins the active checkout and removes stale Workit plugin identities.
- The CLI initialization wizard no longer enters an unbounded render loop after an input change — unchanged controlled values now preserve state identity instead of constructing new drafts.
- Routine structured `info` logs no longer leak into the CLI or OpenCode terminal UI — the CLI sinks only `warn`/`error` to stderr and OpenCode uses native app logging, while durable JSONL diagnostics are preserved.
- CLI installation on Node 24.20 no longer reports an `ini@7` engine warning from workit's dependency tree.
- A fresh local Cursor install now uses `~/.cursor/plugins/local/workit` with `enabled_plugins.workit = true`, and migrates exact legacy `workflow-toolkit` entries only after the replacement succeeds.
- Feature branch creation and PR context now honor workspace/global target-branch policy instead of hardcoding `develop`.
- Cursor install rewrites the plugin mcp.json to an absolute path so plugin MCP servers start in any project directory (package-relative shipped manifest unchanged).
- Workspace matching tolerates OS temp-dir symlinks (`/var` → `/private/var` on macOS) so git-derived realpaths and logical config globs still match.
- PR template discovery returns the actual on-disk template name on case-insensitive filesystems (macOS/Windows).
- Doctor and verification runtime detection probes `*.exe` on Windows so installed node/bun/git are found.
- Plugin identity matching normalizes path separators so Windows `file://` pins are recognized.
- Log redaction and documentation-file listing emit portable path forms on Windows (home-prefix `~` and `./`-relative paths).
- npm publish no longer re-builds adapters inside `prepublishOnly` — the release workflow's build + release-candidate gate already verify the artifacts, and the npm lifecycle's node_modules restructuring broke subpath resolution (`@brainervirus/workit-core/src/*`) mid-publish.
- Cursor runtime commands now pin `@brainervirus/workit-cursor@0.8.0` so stale `_npx` dist-tag caches cannot break MCP/session-start startup; the pin is a deliberate reviewed update, bumped only after the target npm version is public, never a mutable `latest` dist-tag.
- GitHub `prCreate` now pushes the branch (`git push -u origin <branch>`) before `gh pr create` when `pr.pushBranch` is enabled (default), returning a structured `push failed` result on failure; `pr.pushBranch: false` disables the push.
- A caller-supplied PR target equal to the resolved workspace default (`main` under github-flow, `develop` under gitflow) is accepted even though protected; genuine differing overrides to protected or disallowed branches are still rejected.
- Menu receipt label matching now tolerates host qualifiers such as `(Recommended)` and `(new session only)`; original label bytes are preserved.
- Windows CI flake: the RL-03 pr-create target test now gets the 60s per-test budget already used by sibling heavy-git tests (Windows git cold starts).
- Branch setup no longer strands the pre-checkout stash when base/checkout resolution fails — the working tree is restored exactly as it was.
- Verdicts recorded in a throwaway clone are found by the real checkout's merge gate (#311): each verdict is mirrored per remote in the state dir and imported, hash-checked, when a gate runs.
- `workit upgrade` can no longer leave you without a working `workit`: a hand-written wrapper that runs an old install it removes is backed up and replaced by the owned launcher link, the npx cache copy is never treated as an install, and when your shell's `workit` still misses the new install it fails with the exact fix instead of reporting "Verified".
- `workit doctor` no longer counts host plugin launchers (Claude Code, Codex, Cursor, OpenCode, Pi `bin/workit`) as stray CLI installs, and names the obsolete `timezone` key in config.json with its removal fix.
- Claude Code: a spawn that already passes its role's model and effort is left unchanged, and a rewritten spawn's note names the exact model and effort to pass, so auto mode stops refusing spawns. Standing orders reach only Workit workers of their fanout, never other subagents.
- Cursor: hooks no longer answer `allow` for commands Workit does not decide, so your own Cursor permissions apply (#635). A subagent that stops on a usage limit marks that provider exhausted at once.
- `pr status` no longer reads an older commit's CI as the PR head's; a cached update check older than the running CLI is refreshed; `verify-delivery` on a protected branch never suggests a PR from it (#651); `pr merge` prints a start line at once.
- `workit doctor` no longer reports a dev (local-dist) install as stale against npm latest, since main's manifest versions lag the release.
- `workit upgrade` describes a foreign file at the launcher path as "foreign file, left untouched; move it to let the launcher link there" instead of listing it for removal without a command (W2.33), and a wrapper script whose heredoc prints an `exec node …` line is no longer parsed as a wrapper.
- `workit finding resolve` finds the task that holds the finding, and a refused resolve names the evidence that would be accepted (#317). The retro skill files behavioural rules as Workit issues, not host memories.
- Heavy checks: a lease slot that frees too close to `--timeout` (under min(10 s, a quarter of it)) no longer starts the command with a sliver of budget; it exits as a wait timeout. The `stuck?` flag and auto-reap use 1.5x the check's last measured run (never below the configured limit), so long suites on two slots are not flagged. Wait estimates read only the ledger tail, and macOS frees a reused pid's lease through `ps`.
- `fanout worktree create` links node_modules when only other platforms' optional packages are absent (no per-worktree install); several fanout plans name `--fanout` and the candidates, defaulting to the lead's plan (#641); a nested worker glob inside a lead path glob is contained (#647).
- The Workit-Session trailer is removed by git's own trailer-block rule, so a final paragraph mixing prose, Signed-off-by and Workit-Session keeps the prose and Signed-off-by (amend in a trailers-off workspace, and `pr create --fill`). A merge or rebase merge with `--subject`/`--body` is refused naming squash instead of being ignored. The commit-msg hook bounds its check only with GNU `timeout`, never Windows' timeout.exe.
- The usage-limit fallback no longer fires on a report that merely quotes a limit message (a reset must name a time). A heavy check that gives up waiting after auto-reaping a stuck lease now prints the reclaimed notice and records the reap.
- `pr merge` re-reads a transient UNKNOWN mergeability a few times before stopping with wait-forge; PR lookup by branch pages through results on GitHub and GitLab so an existing PR is never missed and duplicated; forge rate limits (429, secondary 403) wait once and then fail as `rate_limited:` with the wait, never as a plain failure; GitLab reads "Pipelines must succeed" for required checks; `--body-file` with CRLF line endings posts LF (#269, #284).
- `workit upgrade` and `workit setup` no longer say zsh's $fpath lacks the completion directory when ~/.zshrc adds it; the hint is styled and says when zsh could not be asked.
- `workit pr merge --allow-failing` no longer records a `merge.waived` row when the merge is refused or fails; the waiver is written once the forge accepts the merge.
- A queued heavy check takes a freed lease slot at once: a release wakes waiters instead of waiting out the poll, and a waiter whose workspace allows fewer slots no longer holds back waiters that can use the free one (the "slot 1: free while 3 waiters queue" stall). `workit lock wait` wakes the same way and, like a heavy check, re-queues once at `resources.wait` before giving up.
- `workit pr create` no longer adds `Closes #<n>` for digits inside a branch slug (only a segment-leading number such as `feature/42-x` links), and unticks template verification checkboxes that no fresh `workit check` on the head backs.
- Review lane reasons name the whole diff when docs, comments or generated lines are left out of the count.
- `workit fanout worktree create` refuses a slice branch that already landed (merged PR, squash or on trunk) and names a free `<branch>-<n>` to put in the plan; a branch with newer commits is still resumed.
- A lead running two fanouts no longer hands one fanout's standing orders to the other fanout's workers.
- The launch update check and `workit doctor` no longer offer or show a latest CLI version cached for another package (such as 14.7.0 after moving to `@workit-dev/cli`): the cache records its package and is refetched when it does not match.
- A fanout plan whose slices have all landed or been released no longer counts as a candidate, so `workit ledger standing add` needs no `--fanout` while only one plan is active (#775)
- `workit git pull|merge|checkout|status`, `ci wait --ref`, `task list --limit` and `help review` now name the exact command that does the job
- A configured check that is red on the merge base as well as the head no longer refuses `tests-verified`; the verdict row records `pre-existing red: <check> (base <sha>)` and `workit pr status` shows it (#771)
- A helper closes the finding it recorded with its own evidence in one call; a refused resolve, wrong payload keys and an out-of-scope worker assignment now name the fix (#317, #647)

### Removed

- **Breaking:** Workit's built-in YouTrack token-file client. YouTrack now requires [ytrack](https://github.com/BrainerVirus/youtrack-cli) installed and logged in to the configured host (`ytrack auth login --host <host>`); every YouTrack call goes through it, whose token stays in the OS keyring. Setup no longer asks for or writes a token; it checks ytrack and names `ytrack auth login --host <host>` when needed. Doctor warns if a leftover `youtrack.token` exists (Workit never reads it; delete it). The `tokenFile` and `tokenDefaults` keys in youtrack.json are ignored.

## [0.6.0] - 2026-08-10

### Added

- Moved the default configuration directory to `~/.config/workit` with automatic legacy migration.
- Added matching configuration-directory behavior to installer and runtime scripts.

### Fixed

- Made partial configuration migrations retry safely and corrected related documentation and skill paths.

## [0.5.6] - 2026-08-10

### Fixed

- Derived package versions at runtime and synchronized versions during release to prevent stale package URLs and metadata.

## [0.5.5] - 2026-08-10

### Fixed

- Corrected CLI branding, Node.js engine requirements, and README prerequisites.

## [0.5.4] - 2026-08-10

### Fixed

- Published the CLI as a fully self-contained bundle.

## [0.5.3] - 2026-08-09

### Fixed

- Made the Cursor development MCP resolve Workit core from the live monorepo.

## [0.5.2] - 2026-08-09

### Fixed

- Made the CLI bundle runnable with Node.js without a Bun shebang.
- Corrected repository URLs and dynamic version badges across packages.

## [0.5.1] - 2026-08-09

### Fixed

- Granted semantic-release the issue and pull-request permissions required for release comments.

## [0.5.0] - 2026-08-09

### Added

- Split Workit into publishable core, OpenCode, Cursor, and CLI packages.
- Added semantic-release, package verification, and a no-Python architecture gate.

### Changed

- Ported changelog, YouTrack, VCS, initialization, presentation, and PR logic to TypeScript.
- Reorganized tests by package and updated package documentation for the Workit rebrand.

### Fixed

- Hardened npm authentication, release permissions, workspace dependency rewriting, package assets, and development plugin pins.
- Corrected work-date serialization and release-time package metadata.

## [0.4.0] - 2026-08-08

### Added

- Added deterministic validation, branch, PR, handoff, and post-plan workflow gates.
- Vendored Superpowers skills and introduced feature-scoped spec, plan, and SDD document layout.
- Added quality templates, structured spec/plan findings, self-review gates, and implementation coverage checks.
- Added docs-repository linking, listing, validation, and spec promotion.
- Added assisted locale and branch-policy configuration, editable templates, and canonical multi-platform rules.
- Added per-turn contract enforcement, bounded-choice detection, clickable documentation delivery, and SDD ignore enforcement.
- Added project hygiene generation and verification for changelog, README, editor, attributes, license, and contribution files.
- Added open-source package metadata, GitHub templates, Cursor marketplace metadata, and a multi-platform CI matrix.
- Added the interactive `workit` initialization wizard with project and workspace setup.
- Added configuration guards, document-rendering rails, GitHub/YouTrack issue linking, and workspace-aware VCS configuration.
- Added verification, TDD, brainstorming, debugging, review-reception, subagent, and issue enforcement rails.

### Fixed

- Hardened token handling, configuration path resolution, cross-platform paths, glob matching, issue parsing, and wizard focus behavior.

## [0.3.18] - 2026-07-30

### Added

- Added GitHub installation, modern CI/release automation, and Cursor deeplink documentation.
- Added monorepo bootstrap, presentation tools, Cursor support, and runtime auto-sync.

### Fixed

- Restored OpenCode workflow commands through a direct plugin pin and corrected Cursor MCP dependency resolution.

## [0.3.17] - 2026-07-15

### Fixed

- Ensured handoff always stops the originating session.

## [0.3.16] - 2026-07-15

### Fixed

- Created interactive continuation sessions during handoff.

## [0.3.15] - 2026-07-15

### Fixed

- Derived handoff stay mode from the invoked command.

## [0.3.14] - 2026-07-14

### Fixed

- Enforced the no-worktree policy through native permissions and closed guard bypasses.

## [0.3.13] - 2026-07-14

### Added

- Introduced the native OpenCode workflow package, safe runtime core, repository context tools, guarded mutations, SDD orchestration, seeded handoffs, and YouTrack integration.
- Added native workflow UX adapters and full integration coverage.

### Fixed

- Hardened workflow boundaries, repository mutations, changelog roots, branch contracts, handoff selection, runtime safety, and time-log validation.

[Unreleased]: https://github.com/BrainerVirus/workit/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/BrainerVirus/workit/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/BrainerVirus/workit/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/BrainerVirus/workit/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/BrainerVirus/workit/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/BrainerVirus/workit/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/BrainerVirus/workit/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/BrainerVirus/workit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/BrainerVirus/workit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BrainerVirus/workit/compare/v0.3.18...v0.4.0
[0.3.18]: https://github.com/BrainerVirus/workit/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/BrainerVirus/workit/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/BrainerVirus/workit/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/BrainerVirus/workit/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/BrainerVirus/workit/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/BrainerVirus/workit/releases/tag/v0.3.13
