# Adaptive Workit: workspace discipline without mandatory ceremony

Date: 2026-09-27.

Status: consolidated design proposal and implementation-facing behavioral specification. The user endorsed the previous recommended direction and requested this written consolidation with new requirements. Detailed schemas, migration implementation, and host capability choices remain proposals until validated; this document is not evidence of shipped behavior or blanket approval to execute effects.

Audience: Workit's maintainer and implementing agents, including an agent resuming this work from another harness.

## 1. Outcome and scope

Workit should apply the user's engineering conventions automatically, support evidence-led discussion when choices are genuinely open, and then execute an authorized outcome autonomously. It is a thin workflow extension, not a replacement harness, permission system, or mandatory project-management process.

Preserve personal/work separation: hosting account, issue provider, branching strategy, branch names, commit style, PR/MR targets, checks, and release rules. Allow repository-specific exceptions and multiple release tracks through validated runtime configuration. Ordinary investigation, OS work, questions, and routine reversible edits must not require starting a Workit lifecycle.

Existing installations need a recoverable upgrade path that removes obsolete Workit-owned integrations from the active project. Historical knowledge remains retrievable without carrying legacy tools, skills, hooks, or approval machinery into the new runtime.

In scope: adaptive methods, workspace/repo policy, autonomous delivery boundaries, selective documents, upgrade/cleanup, bounded history, cross-harness continuation, typed implementation boundaries, and measurable overhead.

Out of scope: executing the upgrade now; deleting current data; rewriting all code in Effect; adding a mandatory Engram server; replacing host sessions; building a general workflow programming language; claiming arbitrary shell enforcement or portable native permissions.

## 2. Authority and evidence for this design

Latest user requirements take precedence over older drafts. This spec replaces the future-design direction of `docs/agile-workflow/spec.md` and its plan, and consolidates relevant ideas from `docs/structural-fixes/spec.md` and `docs/workit-v1/spec.md`. Those documents are historical context, not additional cumulative gates. Installed bootstrap, skills, adapters, and tests must be changed explicitly before behavior changes.

Confirmed during read-only inspection:

- `packages/workit-core/src/core/methods.ts` still requires task start/assessment before product mutations. Canonical plan and steer skills repeat that requirement.
- `packages/workit-core/skills/workit-plan/SKILL.md` escalates changed behavior or package/subsystem counts to a spec. This conflicts with selective durable knowledge.
- `packages/workit-opencode/src/v2/permissions.ts` uses a broad textual worktree matcher. Core shell routing uses active/paused task existence rather than full current-session attribution.
- Branch/commit policy configuration exists, but documents and execution surfaces disagree about enforcing it. The lightweight draft's proposal to remove formatting policy conflicts with the user's explicit intent.
- Core already depends on Zod 4.5.4 and compiles operation schemas. `parseOperation` currently parses successful inputs again with the canonical schema; investigate intent/equivalence before changing it.
- The existing V2 spec allows a bounded Effect lifecycle pilot, not an Effect core/state rewrite.
- Significant prior implementation remains uncommitted. Session `ses_f248c430bffeeMW6QFhjQGq3Xl` and predecessor `ses_f3c0eee64ffeVDSorU5U83lX0y` contain relevant decisions and incomplete verification. Read their saved records; do not launch them merely to recover context.
- Bounded inspection of this repository measured approximately 829 MiB in `.workit`, including 818 MiB of recovery snapshots and 11 MiB of tasks (5,752 recovery files and 74 tasks in the agent's inventory). `TaskStore.replaceSnapshot` saves each full previous record through `saveRecovery`; no retention/pruning path was found. A large task record is approximately 2.57 MB. This identifies recovery amplification here, not every cause of storage growth in every installation.
- Existing `state.export`/`state.import` already validate portable bundles and strip live ownership. Import currently creates a new paused destination task with new IDs/revisions. Extend/reuse this bridge instead of inventing another export format without need.
- `workspaces.ts` already supports custom branch policy and per-workspace commit/hosting settings and rereads files. Its entry validation is shallow and matching selects the first match; the branch detector assumes conventional `main`/`master`/`develop` names. Fix these gaps rather than add a new configuration service.

The user's estimate that an old `.workit` may be approximately 16 GB is a reported symptom, not a measured size or diagnosed cause. Do not infer that it is safe to delete or that all bytes are redundant.

## 3. Separate three responsibilities

### 3.1 Harness permission

The host owns tool permission, filesystem access, sandbox boundaries, and native allow/ask/deny. Workit must never turn a host deny into allow, bypass plan/read-only mode, or use internal subprocesses to evade a shell permission boundary.

A Workit action that performs an effect internally must enter the host's supported permission path for that effect. A generic tool-call allow must not be assumed to cover hidden effects without verifying the host contract. If the host cannot authorize one action, report that limitation for that action, not a global inability to work.

Native question UX and native permission decisions are not automatically equivalent. Prove the supported authorization path per adapter before removing current receipt code. Preserve truthful capability differences across OpenCode V1/V2, Pi, Cursor, Codex, and CLI.

### 3.2 Workit domain policy

Workit resolves the actual target checkout and checks account, branch, commit, issue, PR, and release conventions. A valid action needs no additional Workit approval merely because a task exists. A violation names the rule, its source, the attempted target, and a compliant correction.

Use shared pure validators from managed actions and supported host pre-execution hooks. Do not require every compliant shell action to be rerouted through a Workit wrapper. Do not create a general shell sandbox or match policy against quoted prose/search patterns. Document unsupported shell forms honestly; use repository/CI/provider controls for enforceable coverage beyond host hooks.

Checks for exact target/account, protected refs, concurrent writers, expected remote tips, and uncertain effects remain. Reservations are internal safeguards against duplicate/ambiguous execution, not user-facing permission tickets for every edit. They must not require a full task to exist.

### 3.3 Engineering method

Method selection is proportional to uncertainty, consequences, coordination, and continuity. These are separate dimensions: risk can require a stronger test without requiring a spec; long work can require a checkpoint without requiring independent review; a quick question requires neither.

No mandatory numerical complexity questionnaire, task lifecycle, reviewer panel, spec/plan pair, RED evidence ritual, or cleanup waiver for all requests. Methods can de-escalate when uncertainty is resolved.

## 4. Direct work, tracked work, and autonomy

- Direct work begins under host policy with zero Workit mutation calls when no continuity or shared coordination is needed. Non-Git directories are supported.
- Tracked work uses one compact durable record when handoff, dependent steps, concurrent actors, or meaningful decisions make it useful. Starting it is one small operation; infer observable facts rather than ask the model to populate redundant protocol fields. Repeated starts for the same explicit session/intent key are idempotent; similar titles alone must not merge distinct tasks.
- Delegate only when the benefit exceeds startup/context cost. Protect genuinely concurrent checkout writers; do not impose worker/writer ceremony on every solo read or edit.
- Set the authorized delivery endpoint from the request: investigation, implementation, PR/MR ready, merge, or release. A request to implement does not imply publishing. Once the endpoint and meaningful choices are settled, continue through applicable checks and safe repairs without repeated continuation prompts.
- Stop for missing host authority, a new consequential choice, a conflicting edit, or a blocker that cannot be safely resolved within scope. A failed check normally triggers diagnosis and repair, not an automatic question.
- Verified completion may be recorded from actual evidence without demanding a final human ceremony. Acceptance of known limitations or changed scope remains a real user choice.
- Progress is concise: current action, meaningful result, blocker if any, next step. Never manufacture state changes or busywork to maintain a progress record.

### Steering

Classify new input as same-task adjustment, a separate request, or a quick question. Answer quick questions without forced pause/resume. Update only affected constraints and next actions for same-task steering. Preserve a compact checkpoint when switching substantial work, and resume only when the user's direction calls for it. Do not silently resume an old task after a replacement request.

Instructions already settled by the user are recorded once. A discussion decision is knowledge; it does not fabricate a native permission receipt or broaden the delivery endpoint.

## 5. Critical brainstorming without forced debate

The objective is a defensible decision, not agreement with the user or disagreement for its own sake. Apply the same evidentiary standard to user claims, agent suggestions, and reviewer findings.

For uncertainty or an explicit brainstorm:

1. Establish the desired outcome, constraints, known facts, and important unknowns. Inspect available code/docs before asking the user for discoverable facts.
2. Identify assumptions and test the ones that could change the decision. Label observed evidence, inference, and an untested proposal separately.
3. Present two or three genuinely different viable approaches when alternatives exist. Recommend one; offer two conditional recommendations only when the deciding condition is explicit. Do not manufacture a weak alternative to make the preferred one look good.
4. For each approach give the benefit, cost/risk, when it fits, and the smallest useful validation. Include a short 'worth knowing' caveat only when it changes expectations.
5. Ask consequential questions in dependency order, not an exhaustive interview. Independent choices can be grouped into one small round; downstream choices wait for their prerequisites. If a reversible default is within scope, state the assumption and proceed. Record a settled choice once and stop reopening it without new evidence.

For a precise request with settled constraints, implement it with proportional investigation and verification. Do not force an options menu. If evidence reveals a material contradiction, explain the evidence and offer a focused alternative before proceeding beyond the request.

Brainstorming itself does not require a spec. Produce a durable document only when requested or when the knowledge meets section 6's criteria. Preserve collaborative tone: neither sycophancy nor reflexive contrarianism.

## 6. Durable knowledge and evidence

Choose the smallest record that has a future reader:

- Glossary/context: canonical domain terminology and boundaries, not implementation diary.
- Decision record/ADR: a consequential trade-off whose rationale would otherwise be lost; a short record is sufficient.
- Specification: durable observable behavior, interface, or acceptance agreement.
- Plan: dependencies, bounded steps, verification, and next action needed for execution/resumption.
- Runbook: a recurring operational procedure worth repeating reliably.
- Handoff: unfinished objective, settled decisions, changed files, actual evidence, uncertainty, and next step.

Reuse a project's existing document names and conventions. No speculative empty files, mandatory folders, or duplicate copy of the same decision in every store. References to canonical documents are preferable to reproducing their contents.

Verification must match the changed behavior and actual inputs. Reuse CI/local evidence only when commit/tree, relevant files, dependencies/configuration, and execution environment justify it. A docs-only edit does not automatically invalidate an unrelated check; unknown dependency coverage does not justify silently reusing stale evidence. Independent review is for consequential risks or an explicit request, not every behavior edit. Reviewer findings need evidence and disposition; zero findings is valid.

## 7. Runtime configuration and unusual repositories

### Contract

An agent must be able to implement an authorized repo-rule change as a typed configuration edit, without modifying Workit source, rebuilding, or reinstalling the plugin. Retain existing workspace matching; add named repo profiles/tracks where a single preset cannot express the repository's reality.

Proposed precedence, subject to mapping the existing resolver: built-in defaults, user defaults, matched workspace, repository overrides, then explicit per-task track selection. Selection chooses a configured profile; it is not permission to override protected organizational policy. Equal-priority ambiguous matches require a named choice, not filesystem ordering. Show effective values and provenance.

Keep descriptive workflow config distinct from trusted authority. Repository content cannot grant host access, replace the trusted work account, remove organization restrictions, or authorize publication. Editing a rule to unblock an action must be disclosed as a policy change; never silently weaken policy after a denial. Config writes still use host permissions and user scope.

### Multiple release tracks

Support ordinary presets and named variations. The user's example has one track using `main`/`develop` and another using `nun-main`/`nun-develop`. Neither is inherently the default for an ambiguous release request.

Illustrative data shape only — not a currently supported schema:

```json
{
  "releaseTracks": {
    "standard": {
      "strategy": "gitflow",
      "productionBranch": "main",
      "integrationBranch": "develop"
    },
    "nun": {
      "strategy": "gitflow",
      "productionBranch": "nun-main",
      "integrationBranch": "nun-develop"
    }
  }
}
```

The final schema must also express each track's feature/release/hotfix naming, base and merge-back destinations, PR target, tag namespace/version source, and applicable checks. Reuse shared strategy implementations with data parameters. Do not assume tag/version isolation, cross-track promotion, or merge-back policy for this example; inspect the actual repo and ask only about unresolved consequential choices.

Do not introduce arbitrary executable policy strings or a workflow DSL. If an unusual case exceeds supported typed fields, provide a bounded adapter extension point with declared inputs/effects or explain the unsupported case. Do not pretend an arbitrary script is safely interpreted policy.

### Editing and reload

Provide one discoverable inspect/explain/validate/preview/apply path, preferably extending existing config surfaces rather than adding many model tools. An edit validates schema and semantic references, shows the effective diff and impacted operations, preserves unrelated user content, writes atomically with a revision check, and can be reverted.

Valid local changes become effective for the next operation without restarting the agent. Do not do a global scan on every tool call. Operations retain their resolved relevant-policy fingerprint and revalidate immediately before effects. A meaningful target/account/protection change invalidates the pending operation; unrelated presentation changes do not. Never switch the release track in the middle of an operation.

Invalid changed config produces an actionable diagnostic. Block only effects whose policy cannot be safely resolved; keep read-only/unrelated work available. A previous valid snapshot may be shown for diagnosis, not silently used to continue a now-ambiguous remote mutation. Host configuration may have its own reload limits; report those rather than claim universal hot reload.

## 8. Cross-harness history and explicit continuation

### Portable knowledge, nonportable execution authority

The portable record contains objective, stable source task/project lineage, canonical repo identities and location mapping, selected track, decisions with provenance, relevant documents, progress, checks and their input bindings, delivery endpoint, blockers, and uncertain effects. It must not contain credentials or claim to transfer a model's hidden reasoning. Existing imports assign new local IDs: preserve an explicit source-to-destination mapping and idempotent import identity rather than requiring identical local IDs or silently duplicating imports. Continuing in the same shared store reuses the existing logical record; moving stores establishes the mapped continuation.

Native session IDs remain provenance. Native permission receipts, process handles, live writer ownership, and worker identity cannot be imported as current authority. Preserve old action IDs and observed outcomes so a destination reconciles an uncertain PR/push rather than repeats it. Preserve task history without duplicating an active task per host.

Import retries deduplicate by source workspace/task identity plus export digest, with journaled destination mapping. A later export from the same source is a new revision to reconcile, not automatically a second active continuation. Imported approvals and action outcomes are historical evidence only; any new effect uses current destination authority and a fresh reservation where required.

### Discovery and resume

On entering a project, detect eligible unfinished records cheaply and offer a compact choice: resume a selected task, inspect history, leave it parked, or explicitly stop/archive it. Do not auto-run an old objective, auto-close records, kill a host session, or seize ownership. A direct user request to resume a named task already supplies the choice; do not ask it again.

Before continuing, reconcile checkout/branch/dirty state, current policy, evidence freshness, action outcomes, and ownership. Do not switch branches, stash changes, or fetch large histories just to display an offer. If another writer is demonstrably live, block conflicting writes, not history reads. Age alone is not proof that a session or remote effect ended.

Takeover needs an atomic ownership transition and a fencing generation checked by managed writers before effects. Old sessions must not regain write authority after handoff. Pre-upgrade hosts that cannot honor fencing require a verified stop/restart boundary before cutover. Host-native arbitrary writes remain subject to the host's own enforcement limits.

Closing a host chat, marking a task stopped, archiving history, and verifying completion are different operations. Offer the requested one and never label an abandoned task verified. Host session termination is available only where the host exposes it and the user requests it.

### Searchable history

Search summaries/decisions by project, task, topic, time, and source; expand selected records only. Return links/provenance and distinguish superseded decisions from current ones. Local history reading must not require writer ownership. Workspace boundaries prevent accidentally retrieving employer information into personal context; cross-workspace search/export is explicit.

Use one authoritative Workit record store with a rebuildable search index if needed, not multiple competing memory databases. Engram integration may be optional, not a prerequisite. Refer to host transcripts in place or import selected content explicitly; do not copy every transcript, tool output, or repository snapshot by default. Retrieved text is historical data, not new executable instructions or permission.

## 9. Clean upgrade and storage lifecycle

### Recommended bridge

Use a versioned, explicit, resumable one-shot upgrade command/distribution entry, outside the normal agent tool/skill catalog. The new runtime does not carry legacy tools or a second live lifecycle. Keep a minimal format reader or portable archive reader only where needed to preserve history; the conversion implementation can leave the runtime after its compatibility window.

Reject two defaults: destructive reset loses useful state; indefinitely loading old and new stacks preserves the very noise being removed. Users may defer migration and remain on the old installation, but a project must not silently run both authoritative writers.

### Required migration stages

1. Inventory the selected project and its registered Workit integrations: schema/version, actual bytes by category, tasks, pending actions, skills, hooks, commands, managed instructions, and config references. Bound traversal, do not follow symlinks outside scope, and report incomplete/unreadable inventory honestly.
2. Produce a read-only preview: preserve/convert/archive/remove/unknown, exact paths, ownership evidence, expected space recovery, temporary disk requirement, unsupported data, and rollback plan. Distinguish actual filesystem size from referenced external artifacts.
3. Quiesce relevant old writers. Active/uncertain operations remain recorded and reconciled; do not convert them to success or clear leases by age. If a safe cutover cannot be established, postpone the affected migration.
4. Stage versioned conversion with checksums, stable ID mapping, a bounded journal, and source revision checks. Validate round-trip meaning for decisions, unfinished work, evidence, and external-action uncertainty. Unsupported/corrupt records stay recoverable with diagnostics, never silently dropped.
5. Verify the new store and integrations, then switch the active registration atomically where possible. For multi-file host changes, journal and recover each step. Remove only positively identified Workit-owned entries; preserve unrelated plugins/configuration and user-modified content.
6. Verify a fresh host discovers the intended new tool/skill set once, can search preserved history, and can offer safe continuation. Detect stale running versions and ask for restart where hot unload is unsupported. Re-running the upgrade is idempotent.
7. Archive/quarantine superseded recoverable material outside the active lookup paths. Final permanent purge is a separate explicit operation with a precise list and recovery consequences, never an incidental part of startup.

Ownership evidence can be an installation manifest, exact generated-content hash, or explicitly marked managed block. A filename containing 'workit' is not ownership proof. Modified generated files require a diff/preserve decision. Never erase an entire `.workit`, `.agents`, `.opencode`, skills directory, or shared configuration file to remove a few managed entries.

Removing legacy integrations is separate from converting task state and pruning recovery snapshots. A plugin registration switch does not authorize either of those data operations; each is an explicitly scoped part of the preview.

### Large-state handling

Treat multi-gigabyte history as an input size to support, not permission to discard it. Avoid loading the whole store into memory or making an unconditional same-disk full copy. Stream conversion, preflight free space, support a user-selected archive destination, and resume after interruption. Same-filesystem moves may reduce copying but do not replace integrity verification or rollback design.

Separate compact active state, durable decisions/history, and regenerable caches/artifact blobs. Index references and deduplicate immutable blobs by content where measurements justify it. Retention is configurable and inspectable; pin active/uncertain action dependencies and explicitly retained evidence. Garbage collection must preserve referenced objects and user data. Report active bytes, archived bytes, and permanently reclaimed bytes separately.

Prevent recurrence, not only one-time cleanup: replace unbounded full-record recovery on every metadata update with bounded verified checkpoints or another demonstrably smaller recoverable representation. Select count/byte limits from recovery tests and measurements, expose them in policy, and establish their authority during upgrade/setup. Automatic pruning under that explicit retention policy applies only to eligible new machine-generated recovery data, never silently to legacy history or unresolved/pinned records. At the cap, preserve the last known-good recoverable state and report the storage limitation rather than deleting unknown data or allowing unbounded growth. Independently measure oversized task fields using sizes/types without dumping sensitive content.

Rollback is defined before applying: restore prior registrations/store when no new writes occurred; if the new runtime has written, preserve both generations and reconcile rather than overwrite new work with the old backup. Downgrades must reject newer unsupported state instead of attempting best-effort mutation.

## 10. Typed implementation and performance

Keep one shared domain core and one schema source. Zod validates configuration, tool input, serialized state, and imports at boundaries; generated model schemas may be shallower but runtime validation stays authoritative. Compile reusable schemas once where measured beneficial. Investigate current double parsing with transform/default/refinement/error-equivalence tests before simplifying.

Effect is a candidate for scoped event subscriptions, cancellation, cleanup, bounded concurrency, and recovery scheduling. Pilot one reproduced lifecycle problem against native promises/AbortSignal. Keep Effect internals out of JSON contracts and durable state; avoid a second schema source. Finalization does not prove a subprocess or remote effect never ran. Do not automatically retry non-idempotent mutations after ambiguous failure.

Load only relevant method instructions; keep the invariant bootstrap short. Runtime policy checks are deterministic, not an extra LLM call. Cache effective policy by the relevant revisions without hiding updates. Default tool results are compact; full records are explicit reads. Preserve concise checkpoints at meaningful boundaries, not every tool call.

Measure baseline and candidate on identical scenarios: injected instruction/tool-schema tokens, Workit coordination calls, repeat questions, first-useful-action latency, hook p50/p95, cold startup, search latency, memory, and active/archive storage. Use the actual host tokenizer when reporting tokens; label byte/character proxies. Compare no-plugin baseline, current Workit, and candidate where feasible. No arbitrary performance improvement claim or full-history scan on startup. Numeric budgets require measured baselines; the zero-ceremony acceptance cases below are mandatory immediately.

## 11. Acceptance scenarios

1. **Direct work:** bounded non-Git edit or investigation begins with zero Workit task/assessment/writer calls; host permission remains authoritative.
2. **Rules without ceremony:** a compliant personal commit and work commit follow their different configured styles; an invalid one reports the exact rule without unrelated approval questions.
3. **Dual tracks:** standard and nun release requests choose their own bases, merge targets, and tag policy. An ambiguous request asks once; no cross-track merge happens by inference.
4. **Runtime edit:** an authorized repo-rule patch is validated, previewed, atomically applied, and observed on the next relevant operation without rebuilding. Invalid config blocks only affected actions. Host denies remain denies.
5. **Config race:** a pending action cannot execute against a changed account/target/protection policy. Unrelated config edits do not cause duplicate questions.
6. **Brainstorm:** uncertain requirements receive distinct options with evidence, recommendation and trade-offs; a precise settled request does not receive a mandatory interview. Both user and agent assumptions can be disproved.
7. **Selective docs:** a terminology decision can update a glossary without a spec; a small code fix creates no document; a requested durable contract creates a spec. Existing project formats are respected.
8. **Autonomy:** after the endpoint is agreed and native authority is available, implement/check/repair/PR-ready proceeds without 'continue?' questions. Merge/release remain outside scope unless authorized.
9. **Steer:** a quick question changes no task lifecycle; same-task adjustment preserves progress; a replacement request does not silently reactivate the old task.
10. **Host transfer:** OpenCode-to-Pi continuation preserves decisions/evidence and reconciles actual Git state, but imports no native receipt or live writer authority. An old active owner cannot concurrently execute managed effects after takeover.
11. **History:** selected prior-session knowledge can be retrieved with provenance without resuming anything; default personal searches do not include work history.
12. **Unknown effects:** restart/migration after a PR request timeout reconciles the provider before retry and never creates a duplicate merely because a process disappeared.
13. **Upgrade:** fixtures covering supported old versions, modified generated files, unrelated plugins, symlinks, corruption, low disk, interrupted cutover, and repeated invocation preserve user data and yield one active new integration set.
14. **Large store:** a synthetic multi-gigabyte fixture is converted/searched with bounded memory and no unconditional full duplicate; report actual peak disk/memory. Never use the user's real history as a destructive test fixture.
15. **Cleanup:** old Workit-owned tool/skill/hook entries disappear from active discovery; unknown or modified content stays recoverable. Purge and rollback have explicit, verified outcomes.
16. **Safety parity:** wrong identity, protected ref, live writer conflict, and stale expected tip remain enforced on supported paths. Unsupported host coverage is reported, not fabricated.

## 12. Delivery slices and handoff

This pass writes documentation only. Do not launch migration, close tasks, remove branches, commit the backlog, or publish based on this spec.

Recommended sequence:

1. Reconcile the existing dirty candidate and contradictory docs/tests; preserve valid work rather than reset. Classify what can ship independently. Historical task IDs are evidence, not a command to close them blindly.
2. Pin policy/permission separation with direct-work and workspace-convention acceptance tests; remove broad shell false positives and mandatory startup/steer ceremony.
3. Add validated runtime repo/track configuration using existing resolvers; prove dual-track release routing before touching a real release.
4. Implement selective brainstorming/docs and autonomous endpoint behavior in canonical methods, then regenerate/distribute host copies.
5. Implement portable checkpoints/history and safe explicit takeover using existing export/import/state mechanisms where suitable.
6. Build the isolated upgrade bridge and ownership inventory, then prove interruption/rollback/large-state tests before any live cleanup.
7. Qualify host adapters, packaged artifacts, and measured overhead. A Zod optimization or Effect pilot is independently benefit-gated, not a prerequisite for fixing ceremony.

Open implementation questions, not reasons to repeat settled product discussions: exact config file/schema and inheritance mapping; actual nun track release/tag rules; trustworthy per-host internal-effect authorization; old-format inventory/ownership coverage; retention limits/archive destination; measurable performance budgets; whether existing storage indexing suffices. Research discoverable facts first, then ask only the remaining meaningful choices.

Next agent: read this spec and current git status; recover the referenced saved sessions if needed without invoking their paid agents; inspect the existing implementation and canonical skills; derive a bounded implementation plan. The user is near a usage limit: preserve this document as the current synthesis instead of restarting the brainstorm or treating the old lightweight draft as current.

## 13. Reference provenance and selected lessons

Research used three Luna agents plus primary-source checks. Pinned references below identify Workit's earlier research baseline; `main` links are moving current sources, not claims about those snapshots. Upstream designs inform choices, not authority over this contract.

- [Gentle AI trigger rules](https://github.com/Gentleman-Programming/gentle-ai/blob/72e0cccb1ff10a7cf6ca0270961e903c4d7eb686/docs/trigger-rules.md): separate ordinary/delegated/SDD work. Do not copy file-count thresholds as universal risk or documentation gates.
- [Matt Pocock domain modeling](https://github.com/mattpocock/skills/blob/main/docs/engineering/domain-modeling.md): glossary and selective ADRs have distinct purposes. Workit's runbook category is our extension, not an attributed Matt feature.
- [Matt Pocock grilling](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/productivity/grilling/SKILL.md): research facts and question consequential choices. Do not force every precise request into an interview.
- [pstack standalone mirror](https://github.com/backnotprop/pstack): situational playbooks, autonomy and session pickup. The mirror explicitly adapts Cursor originals; do not claim byte-identical original behavior.
- [Superpowers brainstorming](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/brainstorming/SKILL.md): scaled spike/bounded/architectural paths and options with trade-offs. Borrow those distinctions, not its universal approval gate or one-way escalation. Workit must also de-escalate when uncertainty resolves.
- [Engram](https://github.com/Gentleman-Programming/engram): curated, searchable memory and progressive retrieval; knowledge portability does not transfer host permission or live execution state.
- [OpenSpec overview](https://github.com/Fission-AI/OpenSpec/blob/d0071d7326689a0269332a500c8f56b3f2218ba9/docs/overview.md) and [Spec Kit](https://github.com/github/spec-kit/blob/1bd7743ede29dd22a93237559df26b2b5c773fe4/docs/reference/agentic-sdd.md): useful explicit contracts and consistency when artifacts exist, not a required pipeline for every change.
- [GSD context engineering](https://github.com/open-gsd/gsd-core/blob/eca9c2b590bf49ff37dccd869ce689a34431410a/docs/explanation/context-engineering.md): compact continuity and fresh contexts, with orchestration costs acknowledged.
- [BMAD review triage](https://github.com/bmad-code-org/BMAD-METHOD/blob/7c3e58279bb0594024624e53941286c002b75609/docs/build/review-a-change.md): reasoned finding dispositions and convergent review, not required findings or endless panels.
- [Pi subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md): bounded context and reporting; examples are not a sandbox. Gentle Pi/GSD Pi are additional packaging/lifecycle references in `docs/workit-v1/spec.md`, not replacement runtimes to adopt.
- [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions) and [plugin API](https://opencode.ai/v2/docs/build/plugins): native permission boundaries, configuration transforms and session hooks. Runtime registration does not by itself prove every config field hot-reloads.
- [OpenCode Effect plugins](https://opencode.ai/v2/docs/build/plugins/effect/) and [Zod compilation](https://zod.dev/blog/zod-4-5): bounded lifecycle tools and schema compilation; validate compatibility and measure Workit's own workload.
