# Workflow Toolkit Deterministic Gates Design

**Date:** 2026-08-04
**Scope:** Fix the six confirmed OpenCode/Cursor workflow defects with tool-backed hard gates, dual-platform skill sync, and regression coverage — without forking Superpowers or adding dependencies.
**Branch:** `feature/workflow-toolkit-deterministic-gates`

## Goals

- Stop unbounded spec/plan/task review over-engineering without dropping real Critical/Important/spec-compliance fixes.
- After a plan is saved, always offer one native post-plan choice set that includes handoff (new session), implement modes, and review-spec/plan — never Superpowers' two-option prose alone.
- Command prompts must never render a bare `Arguments:` line; show arguments only when present (including defaults).
- When HEAD is already `feature/*` or `bugfix/*`, keep that branch in spec/plan docs by default.
- New branches are created only from an up-to-date remote `develop`; `main`/`master` never spawn feature branches directly.
- Spec/plan/task-order integrity is validated by tools and **hard-fails** handoff/implement when broken (treat as a toolkit bug).
- PR/MR flow always shows title and body for review before any create confirmation or API call.
- Every gate is tool- or template-deterministic so different agents/models converge on the same outcomes; skills only call tools and report structured results.
- Each defect has failing-first regressions; `bun run check` remains the release gate. Patch bump to `0.3.19` on OpenCode and Cursor surfaces together.

## Non-Goals

- No Superpowers fork or replacement of writing-plans/brainstorming upstream.
- No review-round counter microservice or new UI framework.
- No new production dependencies or test frameworks beyond existing bun / Node `node:test`.
- No restoration of deleted `workflow_prepare_question` MCP adapter.
- No worktrees.

## Architecture

Keep Skill → shared script → OpenCode plugin tool / Cursor MCP tool.

Tools own ground truth. Skills and contracts instruct agents to call tools, map native question results to skill loads, and never invent branch names, task order, or PR bodies from memory when a tool result exists.

Shared scripts under `scripts/` implement validation and branch policy once; OpenCode (`src/tools/*`) and Cursor (`cursor/mcp`) expose the same behaviors.

## Defect Map

| # | Symptom | Deterministic owner |
| --- | --- | --- |
| 1 | Long review over-engineering loops | Implement + doc-review skill contracts; advisory roll-up at end |
| 2 | Post-plan shows implement without handoff / session / review options | Bootstrap + Cursor ask-question rule + fixed option ids |
| 3 | Empty `Arguments:` in chat | Command template generation / static command files |
| 4 | Spec invents a new branch while already on feature/bugfix | Extended `workflow_resolve_branch` / setup + doc write policy |
| 5 | Clean handoff session finds order/consistency bugs | `workflow_docs_validate` hard-fail inside handoff/implement preflight |
| 6 | PR created before title/body shown | `wf-pr` skill order on both platforms |

## Component: `workflow_docs_validate`

New read-only tool on both platforms, backed by a shared script (e.g. `scripts/docs-validate.sh` + small Python/stdlib checker).

**Inputs:** `spec_path`, `plan_path` (required for explicit pairs). Handoff/implement may resolve the linked pair first, then validate.

**Checks (all must pass):**

1. Both files exist and are inside the repository root.
2. Spec and plan contain required headers (`**Branch:**` backtick feature/bugfix; plan also `**Spec:**` path).
3. Plan `**Spec:**` resolves to the same spec file being validated.
4. Declared branches in spec and plan are identical and match `feature/*` or `bugfix/*`.
5. Top-level `### Task N: Title` headings are contiguous from 1 with no gaps/duplicates; task headings do not appear inside fences.
6. Plan task parse (`parse-plan-tasks`) succeeds and task count/titles match the heading scan.

**Output:** `{ ok: true, ... }` or `{ ok: false, errors: [{ code, message, path? }] }`.

**Call sites (mandatory preflight):**

- `workflow_handoff_session` / `workflow_handoff_prompt` — refuse to seed/emit if validate fails.
- `wf-implement` path via `workflow_sdd_context` or an explicit validate call before task loop — refuse to start if validate fails.
- Post-plan self-check after writing the plan — must pass before offering the post-plan question.

Hard-fail only. No warn-and-continue. If this fires in normal use, fix the toolkit or the writer that produced the docs.

## Component: Branch policy

Extend resolve/setup scripts and tools (no parallel branch system).

| HEAD | Behavior |
| --- | --- |
| `feature/*` or `bugfix/*` | **Keep current.** Tools return that branch; spec/plan writers must write that exact name. No silent rename to a new slug. |
| `develop` | `git fetch` + fast-forward `develop` to match remote tracking when possible; then create `feature\|bugfix/<slug>` from that develop tip. |
| `main` or `master` | Checkout `develop` (create local tracking from `origin/develop` if needed), fetch/ff develop, then create the feature/bugfix branch from develop. **Never** `git checkout -b feature/…` from main/master. |
| Other protected / unknown | Structured error. |

If `origin/develop` (or configured integration branch) is missing, return a structured error that develop must exist and be up to date — do not fall back to branching from main.

Slug/kind derivation for *new* branches stays in existing resolve helpers; keep-current short-circuits derivation.

## Component: Post-plan execution choice

Override Superpowers writing-plans “Two execution options” on both platforms via toolkit contract / Cursor `ask-question-only` rule / OpenCode bootstrap.

After plan save and successful `workflow_docs_validate`, present **one** native question (`AskQuestion` / OpenCode `question`) with fixed options:

1. **Subagent-driven** → load `wf-implement` (subagent path)
2. **Inline** → execute in this session per inline/executing-plans path the toolkit already documents
3. **Handoff** → load `wf-handoff` (**new session only**; no `--stay` option in this menu)
4. **Review spec first**
5. **Review plan first**

No stay option. No A/B/C prose duplicate of the same choices. Contract tests assert these five labels/ids appear in the override surfaces and that Superpowers two-option handoff text is forbidden in toolkit overrides.

## Component: Review-loop policy

Applies to spec-document review, plan-document review, and per-task implement reviews.

**Blocking findings:** Critical, Important, or spec-compliance gaps. Max **two** fix+re-review rounds per review subject (spec, plan, or task).

**Advisory findings:** Minor, style, YAGNI, taste. Never pause the work loop. Never auto-fix. Accumulate into a durable advisory list (progress ledger / SDD artifact is enough — no new service).

**After implementation finishes** (all plan tasks done + final verify path reached): present the full advisory roll-up once, then ask which items to address, discuss, or discard. Only then may advisory fixes run.

Round 3+ for blocking findings only if the user explicitly requests another pass.

Encode in `skills/wf-implement`, `cursor/skills/wf-implement`, `templates/execution-contract.md`, and doc-review prompt guidance the toolkit owns or injects. Contract tests assert max-rounds and end-of-implementation advisory roll-up language.

## Component: Command `Arguments:` rendering

OpenCode loads templates from `commands/wf-*.md`. Change generation so:

- No user args and no defaults → `Load the wf-<name> skill and follow it.`
- Args or defaults present → same line plus `Arguments: <values>` (defaults shown when used).

Never emit `Arguments:` with an empty value. Prefer fixing templates and/or plugin command registration so empty `$ARGUMENTS` cannot produce the bare suffix. Cursor slash skills that mirror this pattern get the same rule. Contract test scans commands for the forbidden empty pattern.

## Component: PR preview-before-create

Reorder both `skills/wf-pr/SKILL.md` and `cursor/skills/wf-pr/SKILL.md`:

1. Gather facts (`workflow_pr_context`, verify as today).
2. Draft title + body.
3. **Show** title and body in chat.
4. Native question: create the reviewed MR/PR?
5. On confirm, `workflow_pr_create` with `confirmed: true` and the reviewed fields.

Forbidden: asking to “review title and body” before they exist; creating then printing the body; shell fallback to `glab`/`gh`.

## Reliability and tests

Ponytail: stdlib/bun/`node:test` only; failing test before each behavior change.

**Required regressions (minimum):**

1. `workflow_docs_validate` passes a fixture pair; fails on gap in task numbers, Spec↔Plan mismatch, branch mismatch, missing headers.
2. Handoff/implement preflight returns structured failure when validate fails (no session seed / no task start).
3. Branch policy: keep-current on feature; main→develop sync then create; refuse create from main; error when develop missing.
4. Command templates/registration never produce bare `Arguments:`.
5. Contract: post-plan five options present; Superpowers two-option text absent from toolkit overrides; review max-two + end advisory roll-up present in implement/contract.
6. Contract: both PR skills show-before-create order (draft/show before create question / `workflow_pr_create`).
7. Existing smoke + handoff task-row tests remain green.

**Release:** `bun run check` green; version `0.3.19` synchronized in OpenCode `package.json` and Cursor plugin/MCP manifests.

## Error handling

All new/extended tools return the existing `{ ok, data, error }` (and `stage` where applicable) JSON shape. Skills report failures; never infer success. Validate and branch errors are actionable messages naming the file/check that failed.

## Data flow (happy path)

```text
brainstorm/write spec
  → if HEAD feature|bugfix: docs get current branch from resolve tool
  → if HEAD main|master: switch+ff develop, then create feature|bugfix
  → if HEAD develop: ff develop, create feature|bugfix
write plan (linked Spec + same Branch)
  → workflow_docs_validate (hard-fail)
  → native post-plan question (5 options)
handoff | implement
  → validate again inside tool preflight
  → implement: ≤2 blocker review rounds; advisories accumulated
  → end: advisory roll-up question
wf-pr
  → context → draft → show → confirm → create
```

## Implementation order (for the later plan)

1. `docs-validate` script + tool + fixtures/tests; wire into handoff preflight.
2. Branch policy extensions + tests.
3. Command Arguments rendering + contract test.
4. Post-plan contract/rule/bootstrap + contract test.
5. Review-loop skill/contract text + contract test.
6. PR skill reorder both platforms + contract test.
7. Implement preflight validate; advisory roll-up wording.
8. Version bump + full `bun run check`.
