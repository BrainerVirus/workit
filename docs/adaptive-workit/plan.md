# Adaptive Workit implementation plan

Status: active. This plan is grounded in the dirty tree reviewed on 2026-09-27
and follows [`spec.md`](./spec.md). Keep checkpoints current so another session
can resume without redoing discovery.

## Scope and working rules

- Preserve the existing dirty tree. Do not reset, clean, stash, or discard it.
- The user has since authorized atomic commits, a feature-branch push, a PR,
  and merge after required checks pass. Commit only changes classified as
  useful and in scope; leave historical/noise files for the user's later
  decision. Do not delete the remote branch or publish a release.
- Keep Workit disabled in the active OpenCode host until isolated acceptance
  checks pass, then enable the local package pin using OpenCode's supported
  reload mechanism. Do not run migration or prune history, and never use the
  real `.workit` history as a destructive fixture.
- Implement bounded behavior slices. Native harness permissions remain the
  authority; Workit checks may add restrictions but cannot grant host access.
- Ask only for choices that affect real policy and cannot be established from
  the repository/configuration. In particular, `nun` release/tag rules,
  retention/archive limits, and host authorization for hidden effects need
  evidence or a user decision before their dependent slice ships.

## Dirty-tree reconciliation

- **Committed as reusable implementation:** optional direct-work guidance,
  typed workspace/profile policy, target-bound actions and shared branch
  checks, idempotent portable imports with managed-writer fencing, resumable
  fixture-tested host cutover, and V2 OpenCode packaging. These were committed
  in separate feature slices after reviewing the pre-existing changes.
- **Corrected before commit:** the legacy direct branch helper now validates
  policy at the shared setup boundary; tracker reads use the selected CLI
  identity. The corresponding regression tests pass.
- **Still incomplete:** task-list search now covers summary, progress, and
  decision text within the current workspace, but no automatic project-entry
  resume/history offer or project/time/source index exists. The current list
  path reads task records before filtering, so the 2 GiB inventory benchmark
  does not establish bounded-memory conversion or search. Archive destination
  is being made explicit in the cutover journal; recovery retention limits,
  legacy ownership coverage beyond published 1.2.1 Cursor assets, and measured
  conversion/search remain open.
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
| 2. Typed repo policy | Map and extend the existing workspace resolver/config schemas. Add named repository profiles and release tracks, strict semantic validation, precedence/provenance, and explicit ambiguity. Reuse current branch/hosting strategies. Depends on slice 1 only for policy wording; no real release is run. | Unit fixtures cover each precedence level, invalid references, duplicate/equal-priority matches, profile selection, two independent tracks, and operation-time reload. Unrelated config content survives edits. Invalid policy blocks only affected mutations. |
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
  while preserving unrelated file metadata; rejected ambiguous matches unless
  a matching workspace is named; layered profile values over workspace and
  user defaults with provenance; routed default/explicit profiles through the
  shared branch and commit resolvers; added explicit multi-track selection;
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
- **Next action:** replace broad shell rerouting with shared validators and
  operation-time policy revalidation in slice 3.

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
  those by filename or directory name. Archive destination and retention
  authority remain an unanswered user choice, so archive-space preflight and
  history retention behavior are not implemented. Large-store peak disk and
  memory measurements remain to be done with synthetic fixtures. Keep Workit
  disabled in the active host and leave real `.workit` history untouched.
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
- **Remaining blockers:** archive destination and retention authority remain
  unresolved; recovery retention is not implemented. Ownership is verified for
  the published 1.2.1 Cursor assets only; unknown/modified assets are preserved
  and must not be reported as removed. The 2 GiB measurement covers inventory,
  not conversion or bounded-memory search. Cross-harness import is covered, but
  a project-entry resume offer is not implemented. These migration/history
  limits do not run at startup; do not execute cutover or prune real history
  until the inputs and remaining acceptance are settled.
- **Completed after the slice-5 checkpoint:** `task.list` accepts an optional
  1–200 character query, matches all query terms against task summaries,
  progress, and decisions in the bound workspace, and preserves newest-first
  ordering and the existing result cap. Read-only helper actors can list tasks.
  The list path performs no writes. Regression test: 36 tests / 234 assertions
  passed in `test/workit-core/task-engine.test.ts`; change committed as
  `b8d7677` (`feat(history): add bounded task search`). This is not a full
  project/time/source history index or an automatic entry-time offer, and its
  memory use has not been measured against a multi-gigabyte task store.
- **Adapter checks completed:** `bun run check` passed build, lint, formatting,
  1,571 tests / 8,527 assertions, and TypeScript. Cursor marketplace validation
  passed; React Doctor and Knip exited 0 (React Doctor reported seven advisory
  warnings; Knip reported four configuration hints). This qualifies the
  packaged adapters for the local OpenCode pin after remote CI passes.
- **Next action:** finish and review the explicit archive-path cutover slice,
  run the full local check against the integrated tree, refresh this checkpoint,
  push the committed feature branch, open the PR, resolve required CI findings,
  merge after green checks, then enable and verify the local OpenCode pin.
  Leave the four historical draft files outside the PR and report them for the
  user's later decision.
