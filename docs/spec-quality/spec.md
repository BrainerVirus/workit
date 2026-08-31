# Spec: Systematic spec formatting (diagrams, mermaid, tables)

**Branch:** `feature/spec-quality`

## Context

Superpowers already produces good spec structure: Goals, Non-goals, acceptance criteria, decisions — all in English. What is missing is the **systematic application of formatting add-ons**: ASCII wireframes for UI, mermaid diagrams for flows/architecture, and tables for comparisons/contracts. Today these only appear when the user explicitly asks for them in a session; the toolkit has custom rules but they are not enforced, so different sessions produce inconsistent specs.

Goal: make the formatting add-ons **always-on** — the spec/plan templates require them (when applicable), and validation checks that they are present, so every spec comes out with diagrams, tables, and criteria regardless of model or session.

## Goals

1. Provide a quality spec template (`templates/spec-template.md`) that keeps the Superpowers structure (Context, Goals, Non-goals, Architecture, Acceptance criteria, Decisions) and mandates formatting add-ons where applicable:
   - ASCII wireframe for any UI surface (via `workit_present_ascii`).
   - Mermaid diagram for flows/architecture (via `workit_present_flow`).
   - Tables for glossaries, scope, contracts, comparisons.
2. Provide a matching quality plan template (`templates/plan-template.md`): tasks with explicit criteria, status tables.
3. Extend `workit_docs_validate` to check spec quality beyond headers/branch:
   - Required sections present (Context, Goals, Non-goals, Architecture, Acceptance criteria).
   - Acceptance criteria present and enumerable (CA-01, CA-02, … or equivalent).
   - If the spec mentions UI: at least one ASCII wireframe block.
   - If the spec describes flows/architecture: at least one mermaid block (or explicit "no flow" note).
   - Tables required where the template mandates them (glossary/scope when applicable).
   - Quality check is a hard gate for promotion/implement flows (soft for early drafts: `draft` status may skip).
4. Wire the templates into the brainstorming/writing-plans flow so the agent fills them (skills call the templates + validation).
5. Keep everything in English (user requirement).

## Non-goals

- The docs repo + link + listing + promotion feature (tracked separately as Spec 5).
- Changing Superpowers skill contents (the vendored skills stay as-is; the toolkit's templates/validation add the quality layer on top).
- Auto-generating diagrams (the agent renders them via the present tools; validation only checks presence).

## Architecture

### 1. Templates

`templates/spec-template.md` — full spec skeleton with mandatory section markers and formatting rules:

```markdown
# Spec: <feature>

**Branch:** `feature/<slug>`

## Context
…

## Goals
- …

## Non-goals
- …

## Architecture
<!-- flows/architecture: mermaid required (workit_present_flow) -->
```mermaid
flowchart TD
  …
```

<!-- UI surfaces: ASCII wireframe required (workit_present_ascii) -->
```text
┌──────────────┐
│ …            │
└──────────────┘
```

## Data flow / contracts
<!-- tables for contracts, glossary, scope comparisons -->
| … | … |
…

## Acceptance criteria
- CA-01 …
- CA-02 …

## Decisions
- D-01 …

## Future work
- …
```

`templates/plan-template.md` — plan skeleton: tasks with criteria, per-task status table.

### 2. Validation extension

`src/core/docs-validate.ts` gains a quality pass (opt-in via `{ quality: true }` or a separate `workit_docs_quality` tool) returning structured findings:

- `missing_section` — required section heading absent.
- `missing_acceptance_criteria` — no CA-XX list.
- `missing_ascii_for_ui` — spec mentions UI (heuristic: `UI`, `interface`, `screen`, `modal`, `form`, `component`) and has no fenced `text`/`ascii` block.
- `missing_mermaid_for_flow` — spec describes flow/architecture (heuristic: `flow`, `pipeline`, `sequence`, `architecture`, `diagram`, `workflow`) and has no `mermaid` fence.
- `missing_table` — glossary/contract/scope section present without a markdown table.
- Findings are **warnings** for drafts and **hard failures** at promote/implement time (quality gate).

### 3. Flow wiring

- `skills/wf-implement` + execution contract: after `workit_docs_validate` (structure) run the quality check; block task start on hard quality findings (Critical = missing CA or missing required diagram when applicable).
- Brainstorming/writing-plans skills reference the templates: "fill `templates/spec-template.md`" instead of free-form.
- `workit_docs_validate` output includes `quality: { passed, findings }` so agents surface it.

## Data flow

1. Brainstorm → agent loads `templates/spec-template.md`, fills sections, renders diagrams via `workit_present_ascii`/`workit_present_flow`.
2. `workit_docs_validate` (structure) passes → quality check runs → findings reported.
3. Draft iterations: warnings listed, no block. Approval: quality findings must be resolved (or explicitly waived by the user) before plan approval / promote / implement.
4. Plan written from `templates/plan-template.md`; same quality pass.

## Acceptance criteria

- CA-01: `templates/spec-template.md` keeps the required sections (Context, Goals, Non-goals, Architecture, Acceptance criteria) and mandates ASCII wireframes for UI, mermaid for flows/architecture, and tables where applicable.
- CA-02: `templates/plan-template.md` provides tasks with explicit criteria and status tables.
- CA-03: `workit_docs_validate`'s quality pass returns structured findings (`missing_section`, `missing_acceptance_criteria`, `missing_ascii_for_ui`, `missing_mermaid_for_flow`, `missing_table`) when the corresponding add-ons are absent.
- CA-04: Quality findings are warnings for drafts and hard failures at promote/implement time.
- CA-05: A spec generated via the templates includes ASCII + mermaid + tables without being asked (manual smoke).

## Error handling

- Quality findings never crash; they are structured data surfaced to the agent/user.
- Missing template file at runtime: validation falls back to structural checks only (no hard fail).
- Heuristics may false-positive (e.g. spec about "workflow" with no diagram needed) — findings are advisory at draft stage; user waives at approval.

## Verification

- Template tests: spec written from the template contains all required sections; plan from plan template has task criteria.
- Validation tests: spec with UI mention but no ASCII → finding; spec with flow but no mermaid → finding; spec with glossary but no table → finding; complete spec → clean.
- Regression: existing structural validation behavior unchanged when quality not requested.
- Manual smoke: run brainstorming on a fixture feature; generated spec includes ASCII + mermaid + tables without being asked.

## Compatibility

- Existing specs without the new sections: structural validation still passes; quality check reports findings (advisory for drafts) — no hard break until promote/implement.
- English-only content (no translation layer).

## Out of scope (tracked separately)

- Docs repo link/list/promote (Spec 5).
