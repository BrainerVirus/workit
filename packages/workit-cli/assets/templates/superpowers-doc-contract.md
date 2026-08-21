# Superpowers document contract

Use OpenCode's native `question` for every bounded user choice. Give concise choices and allow a custom answer; if the tool is unavailable, ask one concise plain-text question. Use `skill` to load workflow and Superpowers skills, `todowrite` for task state, and `task` for delegated work.

## Tracked document layout

| Document | Path |
| --- | --- |
| Spec | `docs/<slug>/spec.md` |
| Plan | `docs/<slug>/plan.md` |
| SDD state | `docs/<slug>/sdd/` |

An optional human mirror may live at `docs/specs/<same-basename>.md`; when present, keep its branch identical.

Specs require:

```markdown
**Branch:** `feature/<slug>`
```

Plans require:

```markdown
**Spec:** `docs/<slug>/spec.md`
**Branch:** `feature/<slug>`
```

`bugfix/<slug>` is also valid. Never use `main`, `develop`, `master`, or `prod`. Use plain backtick paths. Top-level headings are exactly `### Task N: Title`; steps use `- [ ] **Step N:** ...`; task headings never appear inside fences.

Before writing **Branch:** into a new spec or plan, call `workit_docs_branch` and write the returned `branch` verbatim. When `action` is `keep`, use the current feature/bugfix branch. When `action` is `create_from_develop` or `create_from_base`, create the branch only through `workit_branch_setup`; it uses the configured workspace/global target branch.

## Execution and handoff

- Implementation uses `wk-implement` and subagent-driven development, with native `todowrite` and `task`.
- Commits use `wk-commit` after its native `question` confirmation.
- Continuation uses `wk-handoff`, whose `workit_handoff_session` creates and seeds the OpenCode session automatically.
- Never use worktrees. Resolve the declared branch with `workit_resolve_branch`, preview dirty-tree stash choices with `question`, and apply an approved in-place checkout through `workit_branch_setup` with `confirmed: true` (grounded in the recorded NativeChoiceEvidence).
- Flow-tool confirmations are never agent-typed booleans and never caller-supplied evidence objects: on OpenCode the plugin records the user's native-`question` answer as a host-observed one-use receipt (`attested: true`, `callID`, `selectedLabel`, `recordedAt`) consumed by `workit_spec_approve` / `workit_plan_approve` / `workit_plan_menu` — no evidence argument exists, and delegated worker status comes from host session parentage (`parentID`), never a caller `role` field. On Cursor, confirmations are policy-only (`attested: false`) and subagent-driven execution is rejected as unsupported.
- Keep all SDD state under the gitignored `docs/<slug>/sdd/`; use `workit_sdd_context` and the registered `workit_sdd_*` tools.
- After implementation, use `question` before an approved stash reapply through `workit_branch_setup` with `confirmed: true`.

## YouTrack content

Chat follows the user's language. YouTrack task comments are Spanish (`es-CL`) and use `workit_youtrack_draft` followed by reviewed `workit_youtrack_post` with `confirmed: true`. Preserve the user's paragraph voice; do not inject commits, file paths, or robotic bullet reports.

## Final self-check

Before handoff, call `workit_docs_validate` on the linked spec/plan pair. Hard-fail on any error; never offer execution when validation fails.

Before handoff, verify the saved spec path, plan path, declared branch, top-level task numbering, and workflow-managed SDD directory through the registered read-only workflow tools. Report structured failures; never infer success.

## Post-plan execution choice

After saving a plan, call `workit_docs_validate` on the spec/plan pair. On failure, stop and fix docs — do not offer execution.

On success, use native `question` / Cursor `AskQuestion` with exactly these options (no stay, no A/B/C prose duplicate):

1. Subagent-driven → load `wk-implement`
2. Inline → execute in this session
3. Handoff → load `wk-handoff` (new session only)
4. Review spec first
5. Review plan first
6. Change model first

`Change model first` is display-only deferral: it ends the turn without calling `workit_plan_menu` and re-presents the menu on the next turn. Every other choice must call `workit_plan_menu` immediately after the answer and before any skill, branch question, mutation, or handoff.

Never emit Superpowers text beginning “Two execution options”.

A handoff destination session (the seeded contract carries `<workflow-handoff-destination>true</workflow-handoff-destination>`) presents exactly five choices — Subagent-driven, Inline, Review spec first, Review plan first, Change model first — and never re-offers the originating handoff option.

- Specs/plans must follow `templates/spec-template.md` / `templates/plan-template.md` (mandated diagrams, tables, CA-XX).

## Doc delivery

When delivering a spec or plan, use a clickable markdown link (\`[spec.md](docs/<slug>/spec.md)\`) and a 3-5 bullet summary of the content (Context, Goals, key decisions, status). Never reference docs with backtick-only paths.
