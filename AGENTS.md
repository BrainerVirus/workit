# Agent Contract

Multi-platform workit: OpenCode, Cursor, Codex CLI/desktop, Pi, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature              | OpenCode                                                                                                                                | Cursor                                                                                                                                                                                      | Pi                                                                                                                                          | CLI                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Approval             | native `question` tool receipts                                                                                                         | AskQuestion policy-only (`attested: false`)                                                                                                                                                 | native `ctx.ui.confirm`; headless `needs_input`                                                                                             | `--confirm` flags / TTY prompts                                                |
| Implementation       | subagent-driven via native `task`, delegated status from session parentage (child `parentID` must equal the coordinator session handle) | native `subagentStart` assignment; file writes pass through to host policy, exact stop identity, AskQuestion answers, arbitrary shell writes, and Tab edits remain agent_guided/unavailable | project-trust `tool_call` boundary; file writes pass through to host policy, shell writes remain agent_guided and no OS sandbox is provided | n/a (`workit task` only)                                                       |
| Lifecycle            | `workit_task` pause/resume/close (native decision receipts)                                                                             | `workit_task` pause/resume/close (policy-only)                                                                                                                                              | session start/compaction/shutdown continuity; supervised stock-Pi worker lifecycle                                                          | `workit task pause\|resume\|close`                                             |
| Handoff              | manual `workit state export` + destination `state import` via the handoff skill (no native session spawn)                               | seeds a handoff prompt for the next agent                                                                                                                                                   | fresh stock-Pi review/worker processes; no nested worker launch                                                                             | `workit state export` + destination `state import` (or printed handoff prompt) |
| Tools                | one dual artifact: V1 `server()` + V2 `setup()`, ten native tools (eight families + read-only context + init apply) with `codemode:false` on V2 | MCP server (`workit_*`)                                                                                                                                                                     | eight native core-backed `workit_<family>` tools (+ adapter-owned `workit_external_action`)                                                 | `workit` commands                                                              |
| Shared MCP transport | n/a (native tools remain host-owned)                                                                                                    | `@brainervirus/workit-mcp`; host wiring remains adapter-owned                                                                                                                               | n/a (native tools remain host-owned)                                                                                                        | n/a                                                                            |
| Skills               | `skills.paths` + fourteen canonical policy-selected method skills (no vendored Superpowers dirs)                                        | plugin `skills/` dirs                                                                                                                                                                       | package `pi.skills` + fourteen canonical method skills                                                                                      | n/a                                                                            |
| Branch policy init   | `workit_init_apply action=branch_policy` (narrow registration)                                                                          | pending — use the wizard screen (unattested MCP cannot mutate)                                                                                                                              | pending — use the wizard screen (no host surface is wired yet)                                                                              | wizard screen                                                                  |
| Distribution         | npm plugin entry (`opencode.json`)                                                                                                      | Cursor Marketplace (git-discovered `.cursor-plugin/plugin.json`)                                                                                                                            | npm package manifest (`pi.extensions`/`pi.skills`)                                                                                          | npm bin (`npx`)                                                                |

OpenCode's native adapter keeps the eight shared operation contracts authoritative while projecting advertised nested schemas to the provider's supported depth; runtime parsing remains core-owned.

OpenCode V1 and V2 expose no managed external mutation tool. Use native host
tools for effects and `workit_context` for read-only inspection; do not rebuild
proposal/approval orchestration or retain a disabled execution alias. Existing
uncertain history remains inspectable and must be reconciled before retry.

Concrete optional Git, hosting, YouTrack, and documentation mutations remain
adapter-owned on host surfaces that can attest the effect. They must run
through the shared one-time action reservation and host-observed settlement,
with an exact canonical operation/target/payload binding (never prose
matching). Caller-unattested MCP keeps optional mutations unavailable. The CLI
`workit action` route has a native terminal confirmation path; headless calls
(including `--confirm` without a TTY) return `needs_input` and never fabricate
an approval receipt.

YouTrack is an optional tracker adapter. Never hard-code greetings, `@mentions`,
people's names, organization hosts, issue ids, meeting wording or a default
timezone in core or tests; they come from `youtrack.json`, and comment wording
belongs in the editable `issue-update` template (a source scan in
`test/workit-core/youtrack-work-date.test.ts` guards hosts, issue-id literals
and hard-coded zones). Work-item dates are calendar days computed with
`Date.UTC` (process timezone unless `youtrack.json` sets `timezone`). The
effective zone is surfaced as `workTimezone` / `workDate` for agents, but never
inside the hashed approval descriptor, which must not vary by process timezone.

Read-only `workit_context` is available on OpenCode; Pi and the CLI use
`context.read` for the
enumerated git/PR/YouTrack/changelog/release/affected contexts without
approval or writer ownership; release context includes a deterministic draft,
and affected context identifies files only. Documentation edits continue
through existing writer-guarded native actions (file writes themselves are host-policy), with CLI identification
remaining read-only. Cursor and Codex expose the same contexts as
MCP resources (`workit://context/{kind}`); resource URIs cannot supply a
workspace or caller identity.

Codex CLI and desktop use the native plugin manifest, hooks, and shared MCP
transport. Hook enforcement is limited to documented covered events; the host
does not expose arbitrary-question receipts or attested writer delegation. A
human may bind a writer to a Codex session explicitly with
`workit writer acquire --actor <session-id>`; the hook honors exactly that
session and nothing else.

Pi uses the stock 0.85.1 package contract. Its extension is self-contained
apart from the Pi peer, reports native session/UI provenance truthfully, and
bundles a coordinator for fresh stock-Pi reviewer/investigator and scoped
implementer processes. Only an observed child process may acquire the shared
writer; cancellation or restart uncertainty blocks replacement ownership.
Pi extensions remain workflow controls, not an OS sandbox, and shell writes are
agent-guided. The parent extension additionally exposes a child-disabled
`workit_worker_control` orchestration tool; it is not a ninth core family and
is never available to supervised children.

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.
   Candidate capture must use Git's ignore-aware inventory in Git workspaces; do not recursively walk ignored trees.
4. Marketplace distribution is host-native: Cursor discovers the plugin from Git (`.cursor-plugin/plugin.json` + tracked skills/rules/assets), OpenCode installs the npm plugin entry, and the CLI ships as an npm bin. The tracked Marketplace artifact is validated in CI by `validate:cursor-marketplace` against the pinned official Cursor JSON schema snapshots (`test/fixtures/cursor-schemas/`). `marketplace.json` `plugins[].source` is repo-root-relative (the directory containing `.cursor-plugin/`), not `.cursor-plugin/`-relative. Never claim Marketplace publication or acceptance; keep the repository submission-ready but not submitted.
5. Cursor runtime execution uses the `@latest` dist-tag with `--prefer-online` and `--min-release-age=0` (`npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest …`). The age override is required while npm/cli#9765 causes `npx` to ignore scoped `min-release-age-exclude` settings; the doctor enforces this exact launcher shape.
6. Stable v1 publication requires deterministic acceptance (`test:acceptance/`,
   `verify:release-candidate`) plus authorized live qualification evidence
   (`docs/workit-v1/qualification.md`). Do not invoke `scripts/run-v1-evaluation.ts`
   or fabricate batch results without explicit model/run/time/usage authorization.
7. Stale-install auto-load repair is automatic and fail-open: the doctor's `stale_install` finding (legacy `mcp.json`/hook selectors, a local-dist install behind the current/published runtime, or an OpenCode `@latest` package cache frozen behind the published `workit-opencode`) is enforced by `install-cursor-plugin.sh` via a `doctor-check.ts cursor --stale` pre-check for Cursor — exit 2 triggers a refresh + canonical re-registration, a healthy install is byte-untouched, and a registry-unreachable comparison warns as `registry_unreachable` (never `stale_install`, never an install failure). Canonical Cursor `@latest` installs never fail on version metadata. OpenCode npm pins keep the bare `@brainervirus/workit-opencode` identity; when OpenCode's `~/.cache/opencode/packages/@brainervirus/workit-opencode@latest` lags the registry, doctor fails with the exact cache path to delete so the next launch re-resolves.
8. Agent-facing behavior rules ship in the distributed surfaces: the invariant bootstrap (injected on OpenCode, Pi, Cursor, and Codex), the method skills (copied to every host), and adapter messages. This file documents this repository's development contract; a rule that lives only here never reaches installed workit instances.

### Where a rule lives

| Rule kind                                                                               | Home                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| How agents behave in any installed project (receipts, decisions, routing, skill choice) | `invariantBootstrap()` in `packages/workit-core/src/core/methods.ts` — injected on every host |
| Method-specific behavior                                                                | the skill under `packages/workit-core/skills/` (the build copies it to every host)            |
| Failure-time guidance for one host surface                                              | that adapter's message strings                                                                |
| How to develop, verify, or release this repository                                      | this file                                                                                     |
| Install and usage information                                                           | `README.md` and the package READMEs                                                           |
| Release-facing history                                                                  | `CHANGELOG.md` and the generated release notes                                                |

Test: if the rule must change what an agent does in an installed workit project,
it ships in a package. Text that lives only in this file never reaches there —
propose the distributed surface first, then use this file to document the
process around it.

## Workflow contract

- Init always shows Codex and Pi with detection/configuration status and host-native
  setup guidance; only OpenCode/Cursor are selectable for Apply. Cutover guidance
  is secondary and explicitly for legacy migration.

- CLI init project hygiene is optional: `n` advances without project writes,
  including after revisiting an accepted project step. Search selectors retain
  the current value and scroll their five-row viewport across all matches.
- Published `workit init` OpenCode registration pins `@brainervirus/workit-opencode`
  (npm); checkout/dev installs keep a `file://` pin. Cursor install copies a real
  plugin directory (not a pnpm-cache symlink). Doctor checks the active
  `gh`/`glab` CLI identity, not separate GitHub/GitLab token files.
  Doctor also fails when OpenCode's frozen `@latest` package cache lags the
  published `workit-opencode` (delete the cache dir and restart OpenCode).
- Task state lives under `.workit/` in the session directory, even when that directory is not a Git repository; never edit it directly. A stale `metadata.lock` (dead/reused pid in the same host, pid namespace and boot; anything else only past its TTL) is reclaimed by the next write or cleared with `workit doctor --fix-lock` (`--force --yes` for an unverifiable lock); contention with a live holder returns retryable `busy`, and `recovery_required` is reserved for genuine state damage. `.workit/recovery/` keeps at most three copies per record; `workit gc` prunes older leftovers. `state.recover` is not advertised to hosts (no shipped host supplies native recovery authority); the engine path remains for embedders that do. Git/hosting actions accept `cwd` for an action-time target checkout without prior attachment; the coordinator task keeps the writer, while a conflicting writer in the target checkout blocks mutation. A managed action holds the target metadata lock through settlement so another writer cannot acquire during the effect. Use the eight shared operation families (`workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, `workit_state`) with closed `action` enums. CLI surface is `workit <family> <action>` (hyphenated actions). There are no `workit flow` aliases.
- `task.list` defaults to a compact, 20-item active/paused projection; bounded closed/all history is opt-in with `status` and `limit`, and `task.inspect` defaults to `summary`. Closed views evaluate their captured closure candidate and carry no current writer lease.
- Workit tracking is optional: direct investigation, questions, non-Git work, and routine reversible edits need no task, policy assessment, or writer calls. Start one compact task only when handoff, dependencies, concurrent actors, or meaningful decisions make continuity useful; assess or reassess when the relevant rules/evidence require it. `policy.preview` stays read-only.
- Routine authorized branch/commit work chooses native host Git/shell tools from the outset when managed coordination or reconciliation is unnecessary. Resolve target conventions; never switch paths after a denial or uncertain managed effect to evade safeguards. A local-commit endpoint creates no PR-readiness or task-closure ceremony. The distributed bootstrap carries this routing guidance.
- A tracked task can be paused or closed when useful; record verified completion from actual evidence without requiring a final lifecycle ceremony. Never invent checks or mark abandoned work verified.
- Helpers are optional and bounded: they cannot widen user scope, record binding decisions, close or pause the coordinator record, assign further helpers, or resolve blockers on behalf of the lead. Use writer ownership only to protect a real concurrent checkout conflict; arbitrary file writes remain governed by native host policy.
- Record consequential user choices once with provenance when future retrieval helps. OpenCode question receipts and Cursor policy decisions describe their host interaction; neither is a substitute for host permission or grounds to re-ask a settled choice. Native allow/ask/deny, sandbox, read-only mode, and organization rules remain authoritative.
- Continue to the delivery endpoint requested by the user, run applicable checks, and repair safe failures without repeated “continue?” prompts. Ask only about unresolved consequential choices or missing authority. Follow configured branch/commit conventions; do not require one commit per task or a separate plan approval. Never commit pre-existing dirty work without establishing its scope and authorization.
- A plan organizes dependencies and checks; it does not authorize branch, commit, remote, migration, or publishing effects. Obtain any required authority through the host-supported path for the specific effect.
- Workit reservations prevent duplicate or ambiguous execution; they are not permission tickets. Workspace auto-approval can skip only duplicate Workit questions where the host supports the effect, and must never override a native host deny, sandbox, read-only mode, or organization rule. Product choices and publish/release remain explicitly authorized.
- Revisions are explicit and singular: every task mutation takes `expectedRevision` (plus `expectedWorkspaceRevision`), one field name everywhere, and exports/imports round-trip through the schema with a single resume path. Worker cancel is idempotent and lead-attested; pause keeps progress with its reason stored separately. Policy gates are enforced, never advisory: `before:write` blocks `writer.acquire` while unsatisfied, close blocks only on `before:close`, and unsatisfied reasons name the expected evidence kind. Close-time testing/verification gates accept only fresh, passing checks the CLI observed (`workit check`, host-only `observeCheck`, keyed to the worktree tree) or an approved limitation; agent-recorded checks are notes, and configured named checks (`workit.checks.json`, else package.json scripts) bind the gate to their exact argv.
- Local external actions authorize the workspace's current writer session, not the task creator's original session. Settled commits and pushes deduplicate by their resolved Git target rather than request text, and uncertain branch/commit/push/changelog outcomes use read-only repository evidence before any retry.
- A reserved `hosting.delete_branch` requires a live remote tip equal to the head SHA of a merged PR/MR; re-resolve before deleting and use a server-side Git `--force-with-lease` expected-tip check to close the read/delete race. Keep drift or ambiguous outcomes intact. Use the effective GitHub/GitLab CLI identity for account checks; never overwrite legacy credential files. Preserve configured branch and commit conventions.
- Delegated authority is direct-child-only where the host exposes a trusted parent binding. OpenCode derives it from native session parentage; Cursor uses documented `subagentStart` identity for bounded assignment and never invents a cross-process token or receipt. Cursor `subagentStop` lacks a stable child identity, AskQuestion answers are policy-only, and arbitrary shell/Tab writes remain unavailable.
- Worker launches are reservation-bound. `prepareWorkerDispatch` /
  `commitWorkerDispatch` are host-only core methods (never a ninth family, never
  caller-supplied receipts): a host durably claims the slot of an
  exactly-`assigned` worker (persisted state `dispatching`) before spawning, and
  only the live reservation settles it as either `started` with the observed
  child session or `not_started` (host-attested `stopped`, null session).
  OpenCode prepares at `tool.execute.before` for a native `task` call with
  exactly one attributable assigned worker; Pi prepares on the live handle
  immediately before spawn. Never mark a worker stopped from a null session,
  missing metadata, a cancellation string, interruption, or a lost
  reservation — those stay unresolved, keep replacement blocked, and block
  closure and resume until reconciled. A fresh managed launch with no
  attributable assignment, or with an unsettled claim, is denied before spawn;
  native task use outside an active Workit task stays unmanaged. Serial native
  `task` calls consume the oldest still-unbound worker first, but only within a
  single task: workers spread across tasks bind nothing, because no observed
  child can prove which task the coordinator intends. A resumed coordinator is
  identified by its current worker assignment (or writer lease), never blocked
  by the task creator's historical session. A `cancelling` worker
  vetoes launches from its own coordinator until a repeated cancel on the ended
  worker confirms its stop; other coordinators proceed. Independent-review evidence
  only counts from a session that is neither the task creator's nor any
  other evidence recorder's. A policy-selected `self-review` accepts the lead's
  own review session, including when the lead recorded checks; freshness and
  matching review-context provenance remain required on every host.
- VCS routing is per-workspace: `workspaces.json` `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow, resolved in the order explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The active `vcs.json` carries no global `defaultTargetBranch`; a global default can no longer shadow a matched workspace's branchPolicy default. Workit's hosted PR/MR create action pre-binds the approved source SHA and post-verifies the provider PR head; the residual non-atomic source-SHA race is accepted (decision ae03c569). The runtime reads only the active `~/.config/workit/` config dir; legacy `~/.config/workflow-toolkit/` non-secret files were cleaned up once the active config passed status checks.
- Never use worktrees; use the configured target checkout and its branch/commit conventions. Supported host pre-execution hooks may validate narrowly recognizable Git/hosting forms against shared policy. Do not require a compliant shell action to be rerouted through Workit, parse quoted prose as policy, or claim coverage for unsupported shell forms; rely on repository/CI/provider controls where host coverage is unavailable. Preserve real writer conflicts and expected-tip checks. A PR URL from an unenforced route may be babysat when the user asks; do not claim Workit enforced creation.
- Before any GitHub remote mutation (push, PR create/close, branch delete), verify the effective identity with `gh api user --jq .login` and, when configured, confirm it matches the target checkout's area account — `gh auth status` shows config metadata and can disagree with the credential actually used (keyring vs hosts file). Never trust the status display for this check.
- Development OpenCode V1 and V2 sessions watch every adapter/core TypeScript source loaded from the checkout. A later source modification emits one fail-open restart warning; installed bundles with no source tree simply retain their bundle marker.
- PR creation does not start babysitting. `babysit:true` opts into PR-ready follow-up; omission or `false` means no follow-up. PR creation and babysitting do not authorize merge or release; require an explicit delivery endpoint and host authority.


## Setup and upgrade maintenance

- Every adapter/package/config version change must keep the basic and advanced
  wizard, native installation commands, marketplace sources, upgrade verification,
  and README instructions current. Maintain temporary-home fixtures for all four
  hosts and Linux/macOS/Windows command planning.
- Keep versioned config migrations idempotent and covered by preservation and
  repeat-application tests. Back up before applying; preserve unknown fields,
  credential files, exact/local pins and narrower workspace overrides. Never
  migrate task history through setup/upgrade or weaken native host permissions.
- Prefer supported native package commands. Verify the installed package version
  and registration, report partial failure without blind retries, and refuse to
  replace files loaded by running hosts. Automatic upgrade belongs before host
  startup via the explicit launch wrapper, never inside a loaded plugin hook.
- New workspace/profile/release-track fields require friendly advanced controls
  and inheritance/preservation tests; do not silently lose them on wizard edits.
- When a host uses this checkout as a local pin, never run root `bun run check`
  or root build: they replace loaded ignored bundles. Run static checks/tests
  directly and use isolated release-candidate packaging. Build scripts accept
  an external target directory; use it for local qualification. Record bundle
  and config hashes before qualification and check them afterward.
