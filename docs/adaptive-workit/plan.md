# Adaptive Workit implementation plan

### Complete setup and upgrade — 2026-10-03

Source: [setup-spec.md](./setup-spec.md). Baseline clean `main` at `c2da781`;
development branch `feat/complete-workit-setup`. Preserve active host pins and
all real history/config; validate machine settings read-only.

1. Independent core slice: remove tracker/hosting coupling; schema/resolver/PR
   link regressions and exact workspace validation. No permission changes.
2. Wizard slice depends on 1: short basic path, advanced commit/branch/tracker
   editors, profiles/tracks, explicit inheritance and effective scope preview.
   Reuse reducers/shared validators and revision-protected apply; test specific
   nun checkout versus broad work and personal scopes, independent of order.
3. Host slice: supported native installation for all four hosts; OS-aware
   detection/all-none-manual selection, disabled absent hosts, reviewed commands
   and sandbox verification. Depends on researched native install interfaces.
4. Upgrade slice depends on 3: inspect/preview/apply/verify package upgrades,
   tested versioned migrations, native automatic updates or optional pre-launch
   wrapper. Local pins stay explicit. Add maintenance requirements to AGENTS.
5. Integrate: focused tests per slice, full supported-Node/static/isolated pack
   checks, atomic commits and PR CI, merge/release/manifest synchronization under
   existing authorization. No activation of a loaded local pin during a session.

Checkpoint: slice 1 complete. Shared workspace validation and VCS resolution
accept YouTrack with either GitHub or GitLab; GitHub Issues retain their hosting
restriction. Schema/resolver/PR-body regressions and existing specificity checks
pass (51 focused tests). Machine config can be validated without editing it.
Luna workers implement wizard/host setup in separate scopes; coordinator owns
upgrade/integration. Next: complete advanced editors and isolated host installers.

Checkpoint: package-directory local pins are now recognized without requiring a
trailing slash, including installed node_modules paths. This prevents setup or
upgrade from overlooking an existing local registration. Registration checks
pass (27 tests / 109 assertions). Advanced wizard and native installers are in
progress; upgrade fixtures pass (6 tests / 32 assertions). The initial full run
identified obsolete host/tracker expectations and wizard navigation fixtures;
update those, then rerun with source edits frozen. Active host configs/bundles
remain untouched.

Checkpoint: advanced wizard slice complete and frozen. Basic/advanced controls
cover branch/commit rules, independent tracker/hosting, profiles/defaults and
release tracks, with duplicate-name guards, effective-policy seeding and shared
pure scope matching. All CLI tests pass on Node 24 (240 tests at handoff).
Host setup covers four detected hosts, native Codex/Pi installers, Cursor npm
staging, explicit pin preservation and V2 plural-registration doctor support.
Native Codex/Pi installs passed in temp homes. Official Docker OpenCode 2.0.21
registered Workit, but rejects scoped server-plugin updates; preserve/report
unsupported rather than invoking all-plugin update. Upgrade review fixes cover
home isolation, inventory failures, stale Cursor manifests and recoverable
CLI package backups. Remaining: final whole-suite/static/packed checks, native
Codex/Pi upgrade qualification, atomic commits/PR/release. No current host reload.

Checkpoint: upgrade slice and local integration complete. Scoped Cursor/Codex/Pi
updates, explicit global CLI updates, idempotent ignored-field migration,
backup/revision checks and opt-in pre-launch ordering are implemented. OpenCode
unsupported updates remain visible and preserve every registration. Native
Codex/Pi refresh from 2.0.1 to 2.0.2 and Cursor npm bootstrap passed in isolated
homes; no real host config was changed. Full frozen-source checks pass on Node
24.20.0: 1,572 tests / 8,541 assertions, typecheck, lint, format, Knip and all
seven isolated tarballs. Current config/bundle hashes match the restored
published baseline below. Remaining: push atomic commits, PR CI, squash merge,
semantic release and manifest-sync CI, then branch cleanup. Local bundle refresh
awaits a stopped-session boundary; a user state question is pending.

Recovery checkpoint: a Luna worker accidentally invoked root `bun run check`,
which rebuilt ignored generated bundles. No real host configuration or reload
was performed. Coordinator restored only generated dist/assets from the
published npm 2.0.2 artifacts, preserving the accidental output under
`/tmp/workit-runtime-restore.y52363/previous-generated`. OpenCode published bundle
SHA256 is `290f41d7a4a423740036af6190e751d6c7f2f6bbada47fe82eca1d24a57c7a72`;
global OpenCode config still hashes to
`2a764f56aefcb5554f9ee47c2de04acdd71cbf603746e9e5d06703dd5eaa72cc`.
Use direct lint/typecheck/tests and isolated candidate packing only; never root
check/build while the checkout supplies a live host pin.

Status: Workit 2.0.2 is published. This setup/upgrade slice follows
[setup-spec.md](./setup-spec.md), alongside the existing adaptive and reliability
contracts. Historical checkpoints below describe their original release state.

## Scope and working rules

- Preserve the existing dirty tree. Do not reset, clean, stash, or discard it.
- The user authorized atomic commits, push, PR, squash merge, and branch cleanup
  for this Workit reliability follow-up. Keep unrelated workspace edits out.
- Workit is enabled in the active OpenCode config from the local checkout; the
  earlier disable-until-acceptance gate is complete. Do not run migration or
  prune history, and never use the real `.workit` history as a destructive
  fixture.
- Implement bounded behavior slices. Native harness permissions remain the
  authority; Workit checks may add restrictions but cannot grant host access.
- Ask only for choices that affect real policy and cannot be established from
  the repository/configuration. In particular, `nun` release/tag rules,
  retention/archive limits, and host authorization for hidden effects need
  evidence or a user decision before their dependent slice ships.

## Current checkpoint — 2026-09-30

- **Changes:** PR #136 removed managed OpenCode mutations on V1/V2; PR #138
  corrected the breaking-release analyzer; PR #139 synchronized manifests.
  All merged and Workit 2.0.0 is published. This branch fixes V2 dispatch
  uncertainty and slash-alias collisions, and aligns the implementation skill
  trigger description across packaged hosts.
- **Checks:** OpenCode V2 regression tests passed (34 tests / 236 assertions);
  full suite passed on pinned Node 24.20.0 (1,539 tests / 8,401 assertions),
  with typecheck, lint, format, Knip and all seven isolated release-candidate
  tarballs passing. The candidate packaging and deterministic slice did not
  modify the active plugin artifact.
- **Remaining blockers:** no code or policy blockers. PR CI and the automatic
  v2.0.1 publication/manifest sync remain. Global config and ignored local
  `dist/plugin.js` still match their pre-change hashes; do not rebuild the
  active pin during a user session.
- **Next action:** commit the two bounded fixes, push/open the PR, then monitor
  checks, merge, release and the generated manifest-sync PR.

## Workspace-routing checkpoint — 2026-09-29

- **Changes:** the narrow `github-web` workspace rule is active again after an
  external backup; runtime VCS/branch resolution selects it over `work`.
- **Checks:** the real config resolves GitHub, `nun-develop`, and protects
  `nun-develop`/`nun-master`; the full repository check passed 1,585 tests and
  8,614 assertions.
- **Remaining blockers:** the separate `main`/`develop` track and tag flow are
  not wired into actions. GitHub workspaces contain YouTrack link settings the
  current GitLab-only linker ignores, and strict whole-file validation flags
  those settings.
- **Next action:** define those track actions and decide whether GitHub PRs
  should receive YouTrack links before enabling either behavior.

## Dirty-tree reconciliation

- **Committed as reusable implementation:** optional direct-work guidance,
  typed workspace/profile policy, target-bound actions and shared branch
  checks, idempotent portable imports with managed-writer fencing, resumable
  fixture-tested host cutover, and V2 OpenCode packaging. These were committed
  in separate feature slices after reviewing the pre-existing changes.
- **Corrected before commit:** the legacy direct branch helper now validates
  policy at the shared setup boundary; tracker reads use the selected CLI
  identity. The corresponding regression tests pass.
- **Still incomplete:** task-list search is workspace-bound and can match
  summaries, progress, decisions, task/workspace IDs, timestamps, and source
  provenance. It still reads task records before filtering; bounded-memory
  search/conversion is not measured. Session hooks now offer up to three
  unfinished records once per session, but the offer is advisory context rather
  than guaranteed visible host UI. Cutover requires an explicit archive path
  and persists it through recovery; archive-space preflight and recovery
  retention limits remain open. Ownership evidence beyond published 1.2.1
  Cursor assets and measured conversion/search also remain open.
- **Preserved outside the PR:** the four untracked Agile/action-target draft
  files remain untouched for the user's later decision. They are historical
  context only and do not override this plan or the consolidated spec.
- **Unrelated changes:** prior YouTrack, doctor, VCS identity/token, auto-
  approval, and reliability work was retained only where it had clear behavior
  and paired tests; no unrelated dirty files were folded into the new design.

## Ordered slices

| Slice | Change and dependencies | Acceptance checks |
| --- | --- | --- |
| 1. Direct work and steering | Remove universal task-start/assessment and close requirements from the invariant bootstrap and canonical skills. Make plan/spec creation selective and quick questions lifecycle-free. Keep task operations available for work that benefits from continuity or coordination. Update contradictory project guidance without erasing unrelated dirty edits. | A bounded non-Git edit/investigation needs zero Workit task, assessment, or writer calls; bootstrap and packaged skill tests contain no universal lifecycle gate; quick-question steering preserves no task state; explicit tracked work still has its existing path. Run focused method/skill tests. |
| 2. Typed repo policy | Map and extend the existing workspace resolver/config schemas. Add named repository profiles and release tracks, strict semantic validation, precedence/provenance, and explicit ambiguity. Reuse current branch/hosting strategies. Depends on slice 1 only for policy wording; no real release is run. | Unit fixtures cover each precedence level, invalid references, broad/narrow glob priority and equal-priority ambiguity, profile selection, two independent tracks, and operation-time reload. Unrelated config content survives edits. Invalid policy blocks only affected mutations. |
| 3. Policy-bound actions | Reuse the dirty target resolver, identity, expected-tip, and lock work after checking call paths. Share pure validators with managed actions and supported pre-execution hooks; replace unconditional shell rerouting with narrow validation and documented unsupported forms. Add operation policy fingerprints and revalidation before effects. Depends on slice 2. | Direct compliant branch/commit work is not forced through Workit. Noncompliant recognized operations name the exact rule, provenance, attempted value, and correction. Wrong account, protected ref, writer conflict, stale tip, and uncertain outcome tests still fail closed. An unrelated policy edit does not duplicate a question. |
| 4. Selective knowledge and delivery | Update canonical methods/skills for evidence-led brainstorming, proportional docs, steering, and an explicit delivery endpoint. Reuse existing method selection and document tools; avoid new ceremony or duplicate stores. | Tests cover quick question, precise small fix with no document, requested durable contract, genuinely open choice with distinct options, and implementation continuing through authorized checks without a `continue?` prompt. Merge/release remain outside scope absent explicit authority. |
| 5. Portable continuation | Extend existing export/import with stable source lineage, digest-based idempotency, source-to-destination mapping, outcome reconciliation, and atomic ownership/fencing. Discovery stays cheap and read-only; takeover never imports native receipts, workers, process handles, or leases. Depends on slices 1 and 3. | OpenCode-to-Pi fixture resumes one logical record, preserves decisions/evidence and uncertain action IDs, does not import live authority, deduplicates retry, and blocks a stale owner from managed effects after handoff. History reads need no writer. |
| 6. Upgrade and bounded storage | Build a separate, resumable preview/apply entry outside normal agent tools. Inventory ownership, bytes, and unknown/modified data; journal a reversible switch; bound only new machine-generated recovery data under explicit retention policy. Depends on slice 5 and resolved archive/retention choices. | Isolated fixtures cover supported formats, modified generated files, unrelated plugins, symlinks, corruption, low space, interruption, rerun, rollback, and bounded-memory large stores. Verify no unknown content is removed. No live migration or cleanup. |
| 7. Adapter and overhead qualification | Qualify OpenCode V1/V2, Pi, Cursor, Codex, and CLI against their real permission capabilities, packaged outputs, and the same direct-work/action scenarios. Measure candidate against current and no-plugin baselines before setting numeric budgets. Depends on slices 1–6. | Host denies remain denies; each hidden effect has a proven native authorization path or a narrow documented limitation. Run affected adapter/artifact checks, use the host tokenizer for token counts where available, and report measured startup/hook/search/storage figures with their fixtures. |

### Dependencies and open choices

Slices 1 and the read-only portions of 2 can proceed independently. Slice 3
needs a resolved policy shape from slice 2. Slice 4 can proceed after slice 1.
Slice 5 reuses existing state transfer but needs action settlement semantics
from slice 3. Slice 6 must not begin destructive behavior until ownership,
rollback, disk preflight, retention authority, and archive destination are
settled. Slice 7 follows only after behavior is stable.

The repository can establish current workspace fields, resolver order, branch
strategy implementations, and existing export/import semantics. It cannot
establish the user's real `nun` tag/version/promotion rules, acceptable retention
limits/archive location, or each host's permission contract for internally run
effects. Implement generic typed fields and isolated host probes first; ask a
focused question only when one of those choices blocks a concrete slice.

## Checkpoint

### Completed: host recovery and reconciliation

- **Changes:** OpenCode v2.0.18's global config had one Workit registration,
  `file:///home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-opencode`.
  Removed only that entry with `opencode plugin remove`; backed up the original
  to `/home/cristhofer-pincetti/.local/state/opencode/workit-recovery/opencode.json.pre-workit-disable.20260927T150744Z.bak`.
  Restarted the running service once so loaded hooks were dropped.
- **Checks:** the restarted service is healthy; `opencode plugin list` reports
  "No plugins found"; `opencode debug config` shows only Command Code remains in
  the plugin list; MCP, provider, skills, formatter/LSP settings are preserved.
  The Workit v2 plugin's `setup()` registered `evaluateShellPermission`, which
  can deny direct branch/PR creation and Git worktree commands.
- **Remaining blockers:** none for the temporary host recovery. Keep it disabled
  until the replacement passes isolated acceptance checks.
- **Next action:** implement slice 1, starting with the canonical bootstrap,
  bundled method preambles, steering/plan skills, and focused regression checks.

### Completed: slice 1 — direct work and steering

- **Changes:** made Workit coordination optional in the core bootstrap and
  project guidance; removed universal task-start/assessment preambles from the
  canonical 14 skills and synced all four host copies; rewrote plan, steer,
  implement, debug, and handoff guidance around selective continuity.
- **Checks:** `bun test test/workit-core/methods.test.ts` — 20 passed;
  `git diff --check` — clean; targeted scan found no mandatory-start language
  in canonical skills; the test verifies all 56 packaged skill copies match.
- **Remaining blockers:** none for this slice. Broad shell rerouting in
  `route-intent.ts` is assigned to slice 3, where it can share policy validators.
- **Next action:** map the existing workspace/profile resolver and config
  validation for slice 2 before selecting the smallest compatible schema.

### Completed: slice 2 — typed repo policy

- **Changes:** added strict typed workspace/profile/release-track validation
  while preserving unrelated file metadata; workspace resolution now selects
  the most-specific matching glob and requires a name for equal-specificity
  matches; layered profile values over workspace and user defaults with
  provenance; routed default/explicit profiles through the shared branch and
  commit resolvers; added explicit multi-track selection;
  made CLI/setup workspace writes preserve metadata, validate replacements,
  and reject stale revisions before any previewed write; made doctor report
  typed errors rather than crash.
- **Checks:** `bun run typecheck`; 73 focused workspace, branch-policy, and CLI
  tests passed; 102 doctor/wizard tests passed under a temporary test-only
  Node 24 version stub (the host itself has Node 22.19.0); `git diff --check`.
- **Remaining blockers:** actual `nun` tag/version/promotion rules are unknown;
  do not ship a real track configuration from the illustrative example. Track
  selection is available as a typed resolver and still needs action-level
  integration in slice 3/4.

### Completed: workspace glob precedence follow-up

- **Changes:** added the saved `github-web` workspace rule back to the active
  user config after saving the previous file outside the config directory.
  Its runtime VCS and branch policy now win over `work` for the legacy repo.
- **Checks:** `fnm exec --using=24.20.0 -- bun run check` — build, lint,
  formatting, TypeScript, 1,585 tests / 8,614 assertions; real config resolves
  GitHub, `nun-develop`, and protects `nun-develop`/`nun-master`.
- **Remaining blockers:** this workspace only selects the `nun` default; the
  `main`/`develop` product track and tag/promotion rules remain undefined and
  release-track selection is not wired into actions. GitHub workspaces also
  carry YouTrack link settings the current GitLab-only linker ignores.
- **Next action:** define the standard/`nun` track actions and decide whether
  YouTrack links should be supported for GitHub before enabling those paths.

### Completed: slice 4 — selective knowledge and delivery

- **Changes:** rewrote challenge guidance around evidence, two or three viable
  options, consequential questions, and decisions as knowledge without
  synthetic permission receipts. Reused the already-proportional plan and
  implementation guidance, adding acceptance coverage. PR babysitting is now
  opt-in (`babysit:true`); an omitted flag emits no follow-up, and explicit
  follow-up stops at PR-ready unless merge/release is separately authorized.
  Updated runtime help, project guidance, README, Cursor alias, and all packaged
  copies of the two affected skills.
- **Checks:** `bun run typecheck`; 55 focused method/external-action tests passed
  with 305 expectations; skill-copy parity passed; `git diff --check` clean.
  Hosted PR creation without `babysit` was verified to return no follow-up
  directive or skill name.
- **Remaining blockers:** keep Workit disabled in the active host until slice 7
  isolated acceptance. Unknown `nun` release rules do not block continuation.
- **Next action:** inspect the existing state export/import and ownership paths
  for slice 5's portable continuation and idempotent source mapping.

### Completed: slice 3 — policy-bound actions

- **Changes:** restricted shell policy checks to direct unquoted literal branch
  creation forms and documented unsupported forms; compliant commands and PR,
  worktree, compound, quoted, variable, and wrapped forms remain with the host.
  OpenCode V1/V2, Pi, and Codex use the shared validator; Codex no longer emits
  an explicit allow. Managed branch/commit actions validate naming/style,
  retain relevant policy fingerprints, and revalidate before effects. Runtime
  policy resolution validates only the matched workspace's relevant policy;
  strict whole-file validation remains available to config editing/diagnostics.
  VCS and CLI identity lookup validate only the selected workspace's VCS fields,
  so unrelated issue-link configuration does not block hosting actions.
- **Checks:** `bun run typecheck`; focused suite — 135 passed across 11 files;
  `git diff --check` clean. Coverage includes hook parity, literal/unsupported
  command forms, compliant direct work, protected refs, unchanged policy after
  presentation edits, stale policy rejection before Git effects, writer leases,
  stale tips, and uncertain outcomes. Follow-up checks: 24 workspace tests,
  6 VCS-scope tests, 34 external-action tests, 3 route-intent tests, and shared
  adapter route parity all pass.
- **Remaining blockers:** keep the host plugin disabled pending isolated
  acceptance of the replacement and slice 7 host authorization qualification.
  `nun` release/tag/promotion rules remain unknown; no real track configuration
  or migration was attempted.
- **Next action:** finish portable continuation in slice 5.

### Completed: slice 5 — portable continuation

- **Changes:** task imports reuse same-store sources and journal source-to-target
  identity/digest mappings in imported task provenance; identical retries return
  the mapping, while changed exports require reconciliation. Portable history
  keeps consumed/uncertain outcomes and prior IDs as inert data, strips native
  handles/receipts/leases, and gives imported actions local non-authorizing refs.
  Managed effects now receive their action reservation's workspace revision and
  reject stale revisions after writer handoff under the shared action lock.
- **Checks:** `bun run typecheck`; 12 continuity tests (73 assertions), 34
  external-action tests (149), 21 CLI task tests, 49 OpenCode task tests, and 25
  Pi extension tests passed. Workspace/VCS isolation tests and route-policy
  parity passed; Pi package discovery used an inspected temporary Node-version
  shim because the shell default was Node 22.19.0.
- **Checks continued:** `fnm exec --using=24.20.0 -- bun test test/artifacts`
  passed 110 tests / 1,074 assertions, including reliability and Cursor doctor
  checks plus isolated npm install. `git diff --check` clean.
- **Remaining blockers:** none for continuation. Keep Workit disabled in the
  active host. Slice 6 is fixture-only; archive destination and retention must
  be explicit apply inputs, and no real history will be migrated or pruned.
- **Slice 6 progress:** preview now returns a bounded no-follow inventory with
  streamed digests, category bytes, exact paths, and registration evidence;
  apply compares that source revision before backup. Cursor sync preserves
  existing skill/vendor content, Pi merges exact Workit paths while retaining
  unrelated arrays, OpenCode only removes exact Workit plugin identities, and
  symlinks block apply. File mutations and generated receipts use atomic writes.
  Cutover now journals configuration, per-host, generation, verification, and
  receipt stages; `cutover resume` requires explicit confirmation and replays
  only unfinished work. Backups use hashed storage paths, verify source/copy
  digests, and read legacy manifests only when their derived paths stay inside
  the backup root. Rollback checks receipt/current/backup digests, restores
  atomically, removes unchanged generated files, preserves `.workit`, and
  reports damaged backups or user edits before writing. Reapplying a setup
  preview skips a workspace list already equal to the reviewed target while
  still rejecting changed entries. Malformed workspace routing remains
  fail-closed; the stale legacy test expectation and incomplete fixture schema
  were reconciled with that behavior.
- **Checks:** `bun run typecheck`; full `test/workit-core`, `test/workit-cli`,
  and `test/artifacts` suite — 1,235 passed / 7,018 assertions across 105 files;
  targeted rollback/CLI/registration tests passed; `git diff --check` clean.
  Reindexed the graph after source changes (5,371 nodes, 13,698 edges). All
  migration and rollback tests used disposable fixtures.
- **Remaining blockers:** positive ownership evidence is still incomplete for
  legacy or modified files inside installed plugin directories; do not remove
  those by filename or directory name. The cutover CLI now requires an explicit
  archive destination, validates it outside config/state/workspace scopes, and
  persists it through the journal, receipt, resume, and rollback paths. Archive
  free-space preflight and recovery retention policy remain unimplemented.
  Large-store peak disk and memory measurements remain to be done with
  synthetic fixtures. Keep Workit disabled in the active host and leave real
  `.workit` history untouched.
- **Completed after the slice-6 checkpoint:** added SHA-256 ownership evidence
  for the generated Cursor skills, aliases, and rule from the installed 1.2.1
  package snapshot. Cutover refreshes only byte-exact known assets; edited or
  unknown files remain intact. Cursor command/rule/skill targets are backed up
  for rollback. Added exact legacy fixtures and assertions for both upgrade and
  preservation behavior.
- **Large-store measurement:** read-only preview inventoried a synthetic sparse
  2 GiB `.workit` file completely in 1.61 s with 122,368 KiB maximum RSS and
  zero allocated-disk change. This measures the streamed inventory path only;
  conversion and history search were not exercised.
- **Remaining blockers:** recovery retention policy and archive-space preflight
  are not implemented. Ownership is verified for the published 1.2.1 Cursor
  assets only; unknown/modified assets stay preserved. The 2 GiB measurement
  covers inventory, not conversion or bounded-memory search. Do not run cutover
  or prune real history until remaining policy and acceptance are settled.
- **Completed history search:** `task.list` accepts an optional 1–200 character
  query and matches all terms against task/workspace IDs, timestamps, source
  provenance, summaries, progress, and decisions in the bound workspace. It
  returns newest-first compact task summaries with source host/kind, leaves the
  store unchanged, and permits read-only helper actors. Focused test: 36 passed
  / 239 assertions; commits `b8d7677`, `da139d9`, and `f1561bd`.
- **Completed project-entry offer:** OpenCode V1/V2, Pi, Cursor, and Codex each
  add a read-only offer for at most three unfinished current-workspace tasks,
  once per host session. It includes source and recent progress, excludes the
  current host session by host and handle, and asks for an explicit user choice
  before resume. Focused suites passed: 98 tests / 566 assertions under Node
  24; the offer remains advisory because these context channels do not promise
  visible or interactive UI. Commit `162cad8`.
- **Completed regression-test corrections:** commit `047e2e4` supplies the
  required disposable archive destination to the cutover doctor fixture;
  `0e065fb` reads the workspace result once so TypeScript can narrow its union
  safely. Both focused tests pass.
- **Adapter checks completed:** `fnm exec --using=24.20.0 -- bun run check`
  passed build, lint, formatting, 1,582 tests / 8,607 assertions, and
  TypeScript. `bun run validate:cursor-marketplace` passed; `bun run knip`
  exited 0 with four configuration hints. React Doctor previously exited 0
  with seven advisory warnings. This qualifies the packaged adapters for the
  local OpenCode pin after remote CI passes.
- **CI portability follow-up:** initial PR run `36372553627` exposed three
  fixture assumptions, not runtime failures: a workspace glob tied to one
  home-directory layout, a Git fixture inheriting the machine's default branch,
  and macOS temporary paths retaining the `/var` symlink alias. Commits
  `13a1a5f`, `b4a29b3`, and `ea93615` make those fixtures checkout-relative,
  pin the fixture base to `develop`, and canonicalize temporary roots before
  writes and path assertions. The full `fnm exec --using=24.20.0 -- bun run
  check` gate then passed again: build, lint, format, 1,581 tests / 8,604
  assertions, and TypeScript. A core-suite run with both a symlinked `TMPDIR`
  and Git's default branch set to `main` passed 910 tests / 4,751 assertions.
  `git diff --check` is clean. PR run `36373877868` then completed with 13 of
  14 jobs green: Linux/macOS core and all other platform/artifact jobs passed;
  Windows core exposed path-string comparison rejecting case/8.3 aliases of
  the same workspace directory.
- **Windows core follow-up:** `TaskStore.readWorkspace` now accepts equal
  directory identities by device/file ID while still failing closed for a
  different or unverifiable directory. A regression test exercises symlink
  identity on Unix and case aliases on Windows. Windows-only fixtures no longer
  assert POSIX group/other mode bits, and two GitLab command-stub tests are
  skipped on Windows because the production runner intentionally avoids a
  shell and cannot execute shell-script shims there. Focused tests (62 / 252
  assertions), the full `bun run check` gate (1,582 / 8,607), TypeScript,
  formatting, and `git diff --check` pass locally. The updated Windows core
  matrix is pending.
- **Windows follow-up after run `36375750473`:** nested managed effects now
  recognize aliased paths to the same directory and have a dedicated lock
  regression. The cross-checkout assertion compares device/file identity;
  cutover history uses the platform path basename. The push-race test now uses
  Git's real `pre-push` hook instead of a shell `git` shim. Only four tests
  that require fake `gh`/`glab` shell executables are skipped on Windows; they
  still run on Linux and macOS, while production remains shell-free. Focused
  verification passed: 119 tests / 501 assertions, typecheck, formatting, and
  `git diff --check`. **Remaining:** rerun the hosted matrix on this follow-up.
  **Next:** commit these fixes atomically, push to PR #132, verify all required
  CI checks, merge without deleting the remote branch, then enable and verify
  the local OpenCode package pin. Keep the active host disabled until merge and
  CI are complete. Leave the four historical draft files outside the PR and
  report them for the user's later decision.
- **Windows path-identity correction after run `36377702496`:** The remaining
  failures split between managed-action locks and chain/plan matching. Shared
  directory identity now resolves case and short/long aliases for target-lock
  selection, cross-checkout checks, chain approvals, and plan commits while
  requiring both paths to exist as directories. Lock regression coverage now
  exercises case and canonical aliases on Windows; the existing foreign-
  checkout test remains green. Focused tests passed (35 tests / 133
  assertions). `fnm exec --using=24.20.0 -- bun run check` passed build, lint,
  formatting, 1,583 tests / 8,609 assertions, and TypeScript; `git diff --check`
  passed. **Remaining:** hosted CI must verify the Windows aliases. **Next:**
  commit the code fix and this checkpoint separately, push both to PR #132,
  verify every check, merge without deleting the remote branch, then enable
  and verify the local OpenCode package pin. Keep Workit disabled in the
  active host until merge and CI are complete.
- **Hosted matrix verified:** PR run `36379475341` on code head `1528711` passed
  all 14 checks, including Windows core (5m3s) and Windows packed artifacts
  (4m13s). This confirms the path-identity fix on the target platform. The
  pending plan checkpoint is documentation-only and will receive its own full
  PR matrix before merge. **Next:** push the checkpoint, verify the new head's
  checks, merge PR #132 without deleting its branch, then restore the exact
  local Workit pin and reload OpenCode.


### 2026-09-30 reliability review checkpoint

- Read-only evidence: OpenCode 2.0.19; active Workit registration is the local
  package pin. Inspected saved V2 records without resuming or modifying sessions.
  Primary reproduction: `ses_f12338d70ffe5maUpR9iR4wujU`, session checkout
  `web/integration`, managed action target `web/frontend`.
- The last 130 assistant records contain 33 Workit calls: 12 `invalid_input`,
  five `needs_input`, and one `requirements_unsatisfied`. These are observations
  of this bounded transcript, not benchmark results or all installations.
- Confirmed defect: commit proposals opened before and after branch creation
  share displayed text but have different resolved descriptors. OpenCode's
  decision binding rejects multiple text matches before checking freshness
  (`packages/workit-opencode/src/tools/workit.ts`, proposal matching and queue).
  Agent changed the commit message to escape the collision and re-asked.
- First correction: re-resolve matching proposals, evict only proven-stale
  descriptors, accept a unique current match, and preserve ambiguity/unknown
  failures. Regression: proposal on develop, branch creation, same-text proposal
  on feature branch, one approval binds the fresh candidate. Also prove real
  staged-content drift and multiple valid targets still fail closed.
- Broader gaps: solo managed commits require task plus writer; post-commit close
  requires assessment; V2 external-action payload is advertised as an open
  object, while bounded family schemas hide nested required fields. Transcript
  retries included stash boolean versus yes/no, decision refs, assessment refs,
  plan_steps, and blocker shapes. Improve discoverability without weakening
  runtime validation; move reservations/authorization orchestration out of
  model-authored lifecycle steps. Preserve native host authority, coordinator
  attribution, target locks and conflicting-target-writer checks.
- Gentle AI's pinned trigger rules already match the current optional-method
  bootstrap. The unresolved mismatch is executable action machinery, not lack
  of another skill. The spec's historical inspection section needs clear
  historical labeling; do not treat those old observations as current code.
- No runtime/config/history changes or live effects were made in this review.
  Existing workspace resolver edits remain untouched. Next: implement and
  verify the stale-proposal regression first, then separately design a direct
  managed-action path and test real cross-checkout sequences with bounded
  coordination-call counts. Do not reload the user's running session.


### Reliability implementation — 2026-09-30

- Contract: `reliability-spec.md` defines the reproduced scenario, authority
  boundaries, A–D dependencies and checks. Existing workspace resolver work is
  preserved as a separate slice; the spec baseline observations are historical.
- Slice C: distributed bootstrap now defaults routine authorized branch/commit
  work to native tools from the outset, with target convention inspection and
  no denial/uncertainty evasion. New bounded behavior assessments keep checks
  and self-review; consequential boundaries, thorough preference and explicit
  constraints retain stronger review. Stored policies are untouched.
  Check: methods + policy resolver, 39 tests / 236 assertions passed.
- Slice A: shared OpenCode V1/V2 proposal binding revalidates every matching
  descriptor before ambiguity; stale candidates alone are evicted. Native
  question sequence provenance prevents old or delayed answers binding a newer
  proposal. Focused adapter suite: 50 tests / 201 assertions passed. Original
  staged-drift and persistence-retry coverage remains.
- Slice B: canonical external-action schemas and richer bounded nested shape
  descriptions are complete. V1 uses canonical operation/payload schemas with
  strict runtime pairing; V2 advertises the full discriminated schema. Checks
  cover stash, plan-step shapes, references, blockers and provider nesting depth.
- Proactive pass: the universal fresh-review policy mismatch was reproduced and
  corrected. A Luna audit is checking rejected actions, restart uncertainty,
  cross-checkout conflicts and schema/runtime agreement. Next: finish audit
  disposition, run all checks in the isolated checkout (path recorded locally
  in `/tmp/workit-reliability-checkout-path`), and preserve active local-pin
  artifacts/configuration until a safe restart boundary. No live real-history
  migration, host reload or publishing is authorized by this checkpoint.

### Reliability acceptance checkpoint — 2026-09-30

- A–C implemented. Proactive pass D found and fixed two additional receipt bugs:
  V2 now captures provenance in `execute.before`, and call identity/sequence
  persist for the plugin instance lifetime instead of expiring after 1,024 calls.
  Regressions cover delayed answers across sibling-checkout branch changes,
  duplicate hook/event delivery and replay after 1,025 consumed receipts.
- Final isolated `bun run check`: build, lint, formatting, 1,592 tests / 8,701
  assertions and TypeScript passed. `verify:release-candidate` verified seven
  local tarballs and deterministic acceptance; marketplace validation passed.
- Installed OpenCode 2.0.19 private loader loaded the candidate and registered
  ten tools with eleven canonical action variants. No model inference or live
  effect was performed; the deliberately unavailable probe model terminates
  after registration. This does not prove model-driven one-shot reliability.
- Audit dispositions are in `reliability-spec.md`: existing serialization,
  uncertainty and rejection protections retained; no rejected-action execution
  defect reproduced. Independent final Luna review found no definite remaining
  defect in proposal binding/receipt ordering. JSON schema size increased;
  no token or latency reduction is claimed.
- Remaining boundary: native permissions for plugin-internal subprocess effects
  are unproven. Do not introduce task-free managed execution on question consent
  alone. Native tools are the direct path from the outset. A bounded model-driven
  qualification remains separate from these deterministic checks.
- Candidate checkout: `/tmp/workit-reliability-_vs8ot7k/checkout`; logs:
  `/tmp/workit-reliability-{full-check,pack,marketplace,native-final}.log`.
  Runtime/test files match the source tree; verification hashes are alongside
  the checkout. Original local-pin artifact and global OpenCode config hashes
  remain unchanged. Existing workspace-resolver edits are preserved and passed
  within the full suite. No real-history migration or publishing was performed.
- Next action: at a safe user session boundary, build the original checkout and
  restart OpenCode once to activate the tested source; inspect new-session
  routing before model-driven qualification. Do not rebuild or reload while
  the current user session is running.

### OpenCode native-effects cutover — 2026-09-30

- Baseline: PR #134 squash-merged, all fourteen PR checks and main CI passed;
  v1.3.1 published. Started from manifest-synced main `94adf7a` with a clean tree.
- User selected removal, not disabled managed executors, on both OpenCode V1
  and V2. The cutover contract in `reliability-spec.md` supersedes OpenCode's
  old external-mutation tool. Shared Pi/CLI effects remain in use.
- Slice 1: delete OpenCode mutation registration, proposal/autoapproval runner
  and obsolete routing; expose strict read-only `workit_context`. Slice 2
  depends on 1: adapt adapter/acceptance tests, retaining generic decisions,
  receipts, workers, shell policy and read-only contexts. Slice 3 depends on
  1–2: docs, full isolated checks, pack checks and installed V2 loader probe.
- Two Luna workers have disjoint source/test scopes; the coordinator owns
  guidance, integration and acceptance. No live-history migration or
  pending-outcome settlement occurred.
- Acceptance includes absent executor on both versions, mutation-shaped context
  input rejected without effects, unchanged state/history and remaining-host
  behavior. Checkpoint and final counts follow after integration.
- Slice 1 complete: mutation registration, executor/proposal/autoapproval code
  and retired repo/YouTrack aliases removed. Context uses the canonical payload
  and existing read helper, without importing the generic effect executor.
  Production typecheck and scoped adapter lint passed. Independent Luna review
  found no definite defect; pinned V1 runtime preserves raw inputs for strict
  handler validation. Shared guidance no longer points to deleted tool aliases.
  Next: finalize tests and isolated build/pack/native loader checks.

- Slices 2–3 complete: obsolete executor tests removed; strict context, receipt
  replay protection, worker provenance, native shell policy and shared Pi/CLI
  effects retained. Updated one historical traceability reference to the current
  no-action-authorization regression. Full isolated `bun run check` passed:
  1,531 tests, lint, format, build and typecheck. Seven release-candidate tarballs
  and marketplace validation passed.
- Installed V2.0.19 and official Docker V1.18.30 loaded the candidate in private
  fixtures and registered the same ten tools, with context present and managed
  executor absent. These are loader checks, not model-driven qualification.
  The V1 fixture container was stopped; no user session was resumed. At that
  checkpoint, source matched the candidate and active artifact/config hashes
  matched baseline.
  Evidence: `/tmp/workit-native-effects-{full-check,pack,v2-probe,v1-probe}.log`
  and `/tmp/workit-native-effects-x7cspusr/` source/host hashes and probe results.
- PR #136 was squash-merged as `d7b06c9`; all fourteen PR checks and main CI
  passed. Release v1.3.2 and manifest-sync PR #137 also completed. Historical
  unknown outcomes require evidence before native retry.

### Release-semantics follow-up — 2026-09-30

- PR #136 passed CI and merged; the release workflow published v1.3.2. Post-
  merge inspection found `analyze-release-scope.ts` only recognized `!` on
  `fix`/`perf`/`feat`, so `refactor!` fell through to the payload-only patch
  rule. This was a release-analyzer gap; v1.3.2 is already public and cannot be
  retroactively relabeled.
- Fix: honor breaking markers on any conventional type; regression-test
  `refactor(opencode)!`; document the Workit 2.0 migration in the OpenCode
  package so selective publishing includes it. The corrective PR must trigger
  major release and publish the OpenCode package as v2.0.0.
- Regression test passes; `bun run check` passed with 1,532 tests, lint, format,
  build and typecheck; an isolated release-candidate pack passed for all seven
  packages. These tarballs still carry 1.3.2; major-release behavior is checked
  from the corrective commit before push and again by CI.
- During that full-check step I mistakenly ran the build from the primary
  checkout. The ignored local `dist/plugin.js` now has SHA-256
  `94c198ba283795b8dadb551b4d34edb7c6d0cf6184734cf1910a4513382bae83`; it
  contains `workit_context` and no `workit_external_action`. The global config
  hash is still `2a764f56aefcb5554f9ee47c2de04acdd71cbf603746e9e5d06703dd5eaa72cc`.
  No host reload or restart occurred. Do not reload the active session; activate
  at a safe restart boundary after the major package is available.
- Next: verify the actual commit resolves to `major`, finish isolated checks,
  publish the corrective PR, watch the major release and manifest-sync PR, then
  activate the local pin at a safe restart boundary.


### Decision continuity and cross-repository delivery — 2026-09-30

- Baseline: clean manifest-synced `main` at `bbf7df3`; v2.0.1 published and local
  pin activated at the user's stopped-session boundary. Latest saved-session
  audit found no new late-interval Workit rejection; observations predate that
  activation. No real task, lease, receipt, or host configuration is edited.
- Slice A (independent): select newest compact decisions with deterministic
  timestamp/ID ordering; expose bounded redacted choice text or retrieval cue.
  Acceptance: newest-eight, ties, redaction, UTF-8/4 KiB bound, unchanged storage.
- Slice B (independent): ship target checkout/branch/deliverables/endpoint and
  held-item checkpoint guidance in bootstrap and canonical steer/implement
  skills; verify requested remote delivery before completion. Acceptance:
  existing guidance/host-copy checks preserve optional tracking/native authority.
- Integration depends on A and B: focused regressions, lint, format, typecheck,
  full supported-Node suite and isolated release-candidate packages; atomic
  commits, PR CI, authorized squash merge, release and manifest sync. Do not
  rebuild/reload the user's active local pin during a session.
- Slice B complete: shared bootstrap and canonical steer/implement guidance now
  bind cross-repo work and held items and require observed remote delivery.
  All five skill copies match; focused methods checks pass (21 tests). Tracking
  remains optional and target conventions/native permissions remain authoritative.
- Slice A complete: newest-first selection handles UTC precision up to nine
  fractional digits and uses stable ID ties; bounded choice excerpts use existing
  redaction, with `task.inspect view=full` fallback for missing substance. Stored
  history/authority are unchanged. Integrated focused checks: 31 tests pass.
- Integration complete locally: 1,541 tests / 8,426 assertions pass on exact
  supported Node 24.20.0; typecheck, lint, formatting and Knip pass. Seven
  isolated tarballs and deterministic release acceptance pass. Final Luna review
  found no remaining defect after response-gating approved text and including
  the actual task ID in the inspection cue. The old summary-shape regression now
  explicitly expects the new choice field while retaining transcript exclusion.
- Active global config and local bundle hashes still match the pre-change
  baseline; no local build/reload or real-history mutation occurred. Evidence:
  `/tmp/workit-context-final-{tests,pack}.log`. Guidance checks establish shipped
  contracts and copy parity, not actual model-following behavior.
- Delivery: atomic runtime/guidance commits were pushed and squash merged in
  PR #142 after all 14 checks passed, with no unresolved review threads. Release
  workflow succeeded for v2.0.2; manifest sync PR #143 merged with all checks
  green. Final main CI and release checks passed at `add4b12`; npm `latest`
  resolves to 2.0.2. Local bundle rebuilt at a stopped-session boundary and
  background service restarted; Workit local and CommandCode 0.10.4 registration
  verified with global config unchanged. Backup:
  `/tmp/workit-v2.0.2-local.7dKw6w/previous-dist-and-assets.tar`.
- Remaining qualification: inspect substantive post-activation sessions for
  concrete failures before proposing more runtime changes. No model-driven
  reliability claim is made; completed historical checkpoints above remain
  chronological evidence rather than current pending work.
