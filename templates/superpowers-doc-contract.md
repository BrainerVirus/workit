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

Before writing **Branch:** into a new spec or plan, call `workflow_docs_branch` and write the returned `branch` verbatim. When `action` is `keep`, use the current feature/bugfix branch. When `action` is `create_from_develop`, create the branch only through `workflow_branch_setup` (never branch from `main`/`master`).

## Execution and handoff

- Implementation uses `wf-implement` and subagent-driven development, with native `todowrite` and `task`.
- Commits use `wf-commit` after its native `question` confirmation.
- Continuation uses `wf-handoff`, whose `workflow_handoff_session` creates and seeds the OpenCode session automatically.
- Never use worktrees. Resolve the declared branch with `workflow_resolve_branch`, preview dirty-tree stash choices with `question`, and apply an approved in-place checkout through `workflow_branch_setup` with `confirmed: true`.
- Keep all SDD state tracked under `docs/<slug>/sdd/`; use `workflow_sdd_context` and the registered `workflow_sdd_*` tools.
- After implementation, use `question` before an approved stash reapply through `workflow_branch_setup` with `confirmed: true`.

## YouTrack content

Chat follows the user's language. YouTrack task comments are Spanish (`es-CL`) and use `workflow_youtrack_draft` followed by reviewed `workflow_youtrack_post` with `confirmed: true`. Preserve the user's paragraph voice; do not inject commits, file paths, or robotic bullet reports.

## Final self-check

Before handoff, call `workflow_docs_validate` on the linked spec/plan pair. Hard-fail on any error; never offer execution when validation fails.

Before handoff, verify the saved spec path, plan path, declared branch, top-level task numbering, and tracked SDD directory through the registered read-only workflow tools. Report structured failures; never infer success.

## Post-plan execution choice

After saving a plan, call `workflow_docs_validate` on the spec/plan pair. On failure, stop and fix docs — do not offer execution.

On success, use native `question` / Cursor `AskQuestion` with exactly these options (no stay, no A/B/C prose duplicate):

1. Subagent-driven → load `wf-implement`
2. Inline → execute in this session
3. Handoff → load `wf-handoff` (new session only)
4. Review spec first
5. Review plan first

Never emit Superpowers text beginning “Two execution options”.
