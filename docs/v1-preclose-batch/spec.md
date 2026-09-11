# Spec: v1 pre-close batch (triage, aliases, babysit, skills, spec-quality, youtrack, steer)

**Task:** `f5cd7c3c` · **Change:** ADDED, one intent: close the five v1 gaps plus the two
interrupt-raised items (YouTrack bodies, steer) · **Decisions in:** babysit
auto-unless-declined, slash bare aliases; triage + roster per user directive
("do all", recommendations adopted).

## 1. Triage: op1 vs op3 comparison (owed) + adopted rule

- **Op1 3-tier auto.** Pros: deterministic — fixes the reported "no session
  triggers the spec" failure structurally; assessor follows size heuristics,
  not memory; Small tier keeps cheap work cheap with an explicit skip marker;
  enforced before-write so it cannot be skipped silently; backed by OpenSpec
  ("match ceremony to stakes"), spec-kit (lean-vs-full), Gentle (risk never
  forces planning). Cons: heuristics misfire at boundaries; one more rule set.
- **Op3 lead judgment only.** Pros: zero machinery. Cons: *is* the status quo
  that produced the complaint; every session re-decides; no audit trail.
- **Adopted: op1 with override.** Tiers below; lead may re-tier with reason
  recorded in progress (answers op3's flexibility objection without losing
  determinism). `task.start` + `policy.assess` stay mandatory at all sizes.
  - **Large → spec + full plan:** new/changed observable behavior, ambiguity,
    cross-package/host contract, auth/data/security surface, irreversible
    migration, or ≥3 subsystems / ≥2 packages touched.
  - **Medium → compact plan-only** (~30-60 lines: Sequence/Acceptance): known
    approach, single subsystem, 2-8 steps. Step count alone never escalates.
  - **Small → neither** (progress + evidence only): single bounded action,
    mechanical, no open choices, reversible. Record `Spec: none (reason)`.
- Mechanism: size heuristics live in `policy.assess` guidance (code +
  `workit-plan` skill text), setting `durableAgreementNeeded` /
  `coordinationPlanNeeded`; reassess when facts change.

## 2. Slash aliases (bare)

`/challenge`, `/babysit`, `/implement`, `/plan`, `/debug` (5 max, Pocock cap —
not 1:1). User-invoked layer: alias → `policy.assess` → model skill(s); an
alias never calls another alias. Per host: opencode `commands/` dir;
Cursor `commands/` + manifest `commands` key; pi `registerCommand` handlers;
Codex CLI has no slash path — document `$workit-*` + `/skills` picker only,
no deprecated `prompts/` shims. Also fix stale README `commands/` claim.

## 3. Babysit-PR (auto unless declined)

PR creation starts babysit by default; per-PR decline (`--no-babysit` / prompt
opt-out). The flag is Call-site intent only: it rides the approved descriptor
(and its tamper-evident marker) so toggling it re-approves — fail-closed by
design, since a silent watch→merge flip would be worse. Loop (pstack babysit, scaled): declare mode, frontier-only (merge
frontier: conflicts → threads → CI), classify-CI-before-retry
(flake vs stale base via merge-base), skeptical bot triage, batch one push
wave. Merge honors existing `pr` settings (squash + delete branch, already
default true) — the missing half was only CI watch/auto-fix. New
`workit-babysit` model skill; core watch helpers host-native (gh / GitLab).

## 4. Seven-stack analysis (owed)

| Source | Steal | Don't steal |
|---|---|---|
| Superpowers | systematic debugging, verification discipline, red-green where apt, implementation/review separation, per-task Files/Interfaces, No-Placeholders, CA-XX | mandatory brainstorming/design for trivial work, methodology-before-everything, always-spec |
| Matt Pocock | grilling frontier (bounded), codebase-answered questions, domain vocabulary + selective ADRs, composable skills, TDD at useful seams, red-loop gate + minimise, two-axis review core, tracer-bullet tickets, `writing-for-agents` doctrine, user-never-calls-user rule, 4-5 alias cap | exact build chain, tracker-coupled machinery, worktree assumptions, unbounded relentlessness, ask-matt runtime router |
| Spec Kit | upstream "should we build this" assessment, strong intent artifacts, lean-vs-full justification, clarify/checklist/analyze/converge as ambiguity-only gates | rigid pipeline + constitution as default for ordinary work |
| OpenSpec | fluid artifacts, delta vocab (ADDED/MODIFIED/REMOVED), skip marker with reason, explore-when-fuzzy, per-tool invocation forms, SHALL + GIVEN/WHEN/THEN discipline, 7-item plan checklist | requiring specs for everything, evergreen-specs merge machinery |
| GSD | fresh-context workers, explicit context engineering, persistent state for long projects, plan-checker loop idea | forcing every task through Discuss→Plan→Execute→Verify→Ship |
| Gentle AI | evidence-based review tier (proof-required findings, causal disposition), outcome receipts invariants (default-off, never-fabricate, review≠delivery), direct small-work path, SDD optionality, skill style-guide + index-not-summary registry, assertion-quality audit | another complete control plane (Go authority store, receipt burn, artifact ledgers) |
| BMAD | scale-adaptive planning as a concept (Quick vs Full) | agent personas and complete lifecycle machinery |

## 5. Skill roster

- **New:** `workit-babysit`, `workit-blast-radius`, `workit-deslop`,
  `workit-diagram` (mermaid syntax + offline validator, flowchart/sequence/
  state/ER only, no renderer), `workit-mockup` (ASCII wireframes,
  humbleteam discipline + component/state artifact), `workit-green-run`
  (CI loop), `workit-steer` (§8).
- **Upgrade:** `workit-debug` (red-capable gate + loop menu + minimise +
  hypothesis format), `workit-review` (fixed-point pin + Fowler-12 baseline
  + proof-required findings + causal disposition), `workit-challenge`
  (grilling frontier, bounded by receipt semantics), `workit-plan` (tracer
  slices + blocking edges + triage tiers), all skills to style guide
  (token budget, trigger-first description, completion criteria).
- **Reject for v1:** multi-model review, self-modifying skills,
  vendor-hosted tools, `how`/`why` explainer (defer), ToB security set
  (defer, gated later).

## 6. Spec quality (template)

Keep `docs/<slug>/spec.md` + fixed headers; add: first-line
`Change: ADDED|MODIFIED|REMOVED + one-sentence intent`; requirements as
numbered `SHALL/MUST`, one per bullet, observable, no how, each with ≥1
GIVEN/WHEN/THEN incl. most-regretted edge; `Spec: none (reason)` skip
marker; Architecture may be `N/A (reason)`; review = 7-item checklist;
diagrams: tables first, ASCII trees, mermaid when flow/architecture needs
it (via `workit-diagram`).

## 7. YouTrack bodies (interrupt-raised bug)

Root cause (read, not guessed): `context.read kind=youtrack` resolves to
`youTrackContext` (`youtrack.ts`), which returns config + greeting +
issueId + issueUrl and **never calls the API for the issue** — bodies are
unreachable by construction, so sessions fall back to titles. Fix: fetch
`summary + description + state` via
`/api/issues/{id}?fields=idReadable,summary,description,customFields(name,value(name))`
with the existing token path (state = the `State` custom field when present,
else null); return them in context; fail closed with `capability_unavailable`
when creds exist but the fetch fails. No creds degrades honestly to the link
shape with `issueBody: null` plus the creds error — never an empty success,
and offline use keeps working. Out of scope: SDK combobox API + NSAT-15 domain answers belong to
the NSAT work repo — unblocked once bodies flow.

## 8. Steer protocol (interrupt-raised)

Mid-session steering (new item, interruption, "forgot X") currently loses
the thread. New `workit-steer` model skill + `workit-plan` clause: on new
instructions, (1) park current state to progress (summary/nextAction/
blockers verbatim), (2) classify: same-task / new-task (start + assess) /
quick-question (answer, resume), (3) handle, (4) re-anchor with one-line
resume brief. Steals: Pocock phase boundaries + handoff-at-limit, Gentle
incident rule, OpenSpec fluid artifacts (edit plan, keep going).

## Acceptance

- CA-01 triage tiers enforced in assess guidance + skill text, override path tested.
- CA-02 five bare aliases work on opencode/cursor/pi; codex `$` documented; stale README fixed.
- CA-03 PR auto-babysits, declines cleanly, merges per `pr` settings after green.
- CA-04 seven new skills ship on all hosts with parity tests; four upgraded skills keep old triggers working.
- CA-05 template changes applied to `spec-template.md`; this spec follows them.
- CA-06 `context.read` youtrack returns live NSAT bodies (auth-gated live check) or honest `capability_unavailable`.
- CA-07 steer park/classify/resume covered by skill text + one test where code exists.
- CA-08 full suite green, lint/format/tsc clean, fresh-context review approved.
