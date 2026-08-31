# Spec: Self-review enforcement — quality gate en la transición

**Branch:** `feature/self-review-enforcement`

## Context

The flow gate marks a spec/plan `self_reviewed` on the first `transitionSpec`/`transitionPlan` call with `confirmed: true` — with **no evidence that the content was reviewed**. This happened in practice: the agent marked a spec self-reviewed without checking it against the template, invalidating the flow's review semantics.

The self-review concept originates from the vendored `superpowers:writing-plans` skill (Self-Review section): a **cognitive checklist** the agent runs itself — (1) spec coverage (every spec requirement maps to a task), (2) placeholder scan, (3) type consistency. The toolkit's own customization adds the automatable half: `qualitySpec` (hard findings: missing required sections, missing CA-XX) and `parseTasksFromPlan`. This spec makes BOTH halves enforced: the tool-level quality gate (unskippable rejection) AND the superpowers checklist surfaced as the agent's required ritual before calling the first approval (via the per-turn contract reminder).

## Goals

- G1: `transitionSpec` (draft → self_reviewed, first confirmed call) runs `qualitySpec` on the spec text; any **hard** finding → `{ ok: false, error }` listing the missing items; status stays `draft`. Second call (self_reviewed → approved) unaffected.
- G2: `transitionPlan` (draft → self_reviewed) validates the plan parses (`parseTasksFromPlan` returns ≥1 task) and required headers exist (`**Spec:**`, `**Branch:**`, `### Task N:` headings); failure → rejected with detail; status stays `draft`.
- G3: The rejection message is actionable: it names the missing section(s)/CA-XX or the plan-header problems so the agent can fix and retry.
- G3b: The cognitive half is enforced too — the contract reminder adds the superpowers self-review ritual: before the first `workit_spec_approve`/`workit_plan_approve`, the agent must run the writing-plans Self-Review checklist (spec coverage, placeholder scan, type consistency) and fix findings inline. The reminder text mirrors the superpowers skill's own checklist.
- G4: Existing flows keep working: `workit_spec_approve` ×2 and `workit_plan_approve` ×2 sequences unchanged in UX; warnings never block (only hard findings).

## Non-goals

- No changes to the second approval (user-approved → `approved`).
- No new quality rules (reuse `qualitySpec`'s current rule set; adding rules is future work).
- No changes to `docsValidate`'s combined spec+plan validation (already used as the post-plan gate).
- No UI/reminder changes (this is a tool-level hard gate).

## Architecture

```mermaid
flowchart TD
  %% Spec: self-review enforcement — quality gate en la transición
  approve["Self-review (draft → self_reviewed)"]
  gate["Quality gate interno"]
  findings["Scan spec/plan"]
  branch["¿Hard findings?"]
  reject["Rechazo + lista de faltantes"]
  ok["Transición permitida"]
  approve -->|workit_spec_approve (1ra vez)| gate
  gate -->|qualitySpec + parseTasks| findings
  findings -->|hard findings?| branch
  branch -->|sí → rechazo con detalle| reject
  branch -->|no → self_reviewed| ok
  reject -->|agente corrige y reintenta| approve
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| `qualitySpec(text)` | Existing — returns `QualityFinding[]` with `severity: "hard" \| "warning"` (missing required section, missing CA-XX = hard) |
| `parseTasksFromPlan(text)` | Existing — parses `### Task N:` headings |
| First transition | `confirmed: true` from `draft` (nextStatus: draft → self_reviewed) — the gated step |
| Second transition | `self_reviewed → approved` — ungated (user already approved) |

## Acceptance criteria

- CA-01: A spec missing a required section (e.g. no `## Acceptance criteria`) → first `transitionSpec(confirmed: true)` returns `{ ok: false, error }` naming the missing section; flow status stays `draft`.
- CA-02: A spec with no CA-XX → rejected with the missing_acceptance_criteria error; stays `draft`.
- CA-03: A compliant spec → first transition succeeds to `self_reviewed`; second succeeds to `approved`.
- CA-04: A plan that doesn't parse (no `### Task N:` headings) → first `transitionPlan(confirmed: true)` rejected, stays `draft`; a compliant plan (spec approved + parses) → self_reviewed, then approved.
- CA-05: Warnings (hygiene, style) never block — a spec with only warning findings transitions fine.
- CA-06: The contract reminder (`REMINDER_TEXT`) includes the superpowers self-review ritual line (spec coverage / placeholder scan / type consistency) — asserted by a reminder-text test.
- CA-07: `bun run check` green; tests cover CA-01..CA-06; docs validate ok.

## Decisions

- D-01: Hard gate in the core transition functions (user's detected gap) — the rejection is tool-level, unskippable.
- D-02: Only the FIRST transition is gated (draft → self_reviewed); the second (→ approved) is the user's call.
- D-03: Reuse `qualitySpec`/`parseTasksFromPlan` verbatim — no new rule set in this spec.
- D-04: Warnings stay advisory (consistent with wf-implement's hard/warning split).
- D-05: Two halves, two mechanisms — automatable checks hard-gate in the core (unskippable); the cognitive checklist (superpowers) is enforced via the per-turn reminder (skippable by design, like every rail — the hard gate catches what it can).

## Future work

- Extend the rule set (mermaid presence, CA numbering continuity, plan-step checkboxes enforced).
- Self-review checklist surfaced in the rejection message (what a proper self-review should confirm beyond the automatable checks).
