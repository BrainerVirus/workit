## HARD-GATE — Cursor AskQuestion for EVERY choice (read first)

**This overrides Superpowers brainstorming** (“ask clarifying questions in chat”, “A/B/C text options”, “present options conversationally”).

If the user must pick among options (product identity, layout, approach, yes/no, confirm, branch, stash, meetings, …):

1. Call Cursor's native **`AskQuestion`** with a specific title, prompt, and options
2. Do **not** repeat the options as chat markdown
3. If the native tool is unavailable, ask one concise plain-text question

**Illegal:** `A) … B) … C) …`, “Reply with A, B, or C”, bullet choice lists as the answer UI, “First clarifying question” with lettered options in prose.

Open-ended free text with **no** options may stay in chat. **Any options → AskQuestion only.**

---

## Workflow-toolkit: Superpowers spec/plan format (handoff-ready)

Apply whenever **brainstorming** writes a spec or **writing-plans** writes a plan in this repo.

### Agent language (default: English)

- **Chat, questions, setup, skills, status tables:** English unless the user writes in another language — then match their language.
- **YouTrack issue comments only:** Spanish (`es-CL`) via `workflow_youtrack_draft` / `workflow_youtrack_post` — polish the **user's draft** (grammar + flow, paragraph voice); greeting + `# Actualización` envelope only. Never auto-inject git commits, file paths, or bullet reports. See `wf-issue-update/references/youtrack-update-style.md`.

---

| Doc  | Path                                                 |
| ---- | ---------------------------------------------------- |
| Spec | `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` |
| Plan | `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`        |

Optional human mirror: `docs/specs/<same-basename>.md` — if used, keep **Branch** identical. Handoff prefers `docs/superpowers/specs/`.

### Spec header (required)

```markdown
**Branch:** `feature/<slug>` # or `bugfix/<slug>` — never main, develop, master, prod
```

### Plan header (required)

```markdown
**Spec:** `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`
**Branch:** `feature/<slug>` # same as spec when possible
```

Use a **plain backtick path** for **Spec:** (not only a markdown link).

### Tasks (required)

- Top-level tasks: `### Task N: Title` only (**not** `## Task`)
- Steps under each task: `- [ ] **Step N:** …`
- Do **not** put `### Task N:` inside fenced code blocks (handoff parser treats them as real tasks)

### Execution

Implementation uses **subagent-driven-development** + workflow-toolkit `/wf-handoff` (not executing-plans). Commits: `/wf-commit` skill — no separate commit-policy field.

### Self-check before handoff

```bash
bash ~/.cursor/plugins/local/workflow-toolkit/scripts/lib/parse-plan-tasks.sh docs/superpowers/plans/<plan>.md
bash ~/.cursor/plugins/local/workflow-toolkit/scripts/lib/resolve-handoff-branch.sh docs/superpowers/specs/<spec>.md docs/superpowers/plans/<plan>.md
```

---

## Questions — Cursor native UI only (same HARD-GATE as top)

Same rule as the HARD-GATE at the top of this file. Quick map:

| Situation                      | Native `AskQuestion` content                    |
| ------------------------------ | ----------------------------------------------- |
| Brainstorming / clarifying MCQ | Specific title, prompt, and labeled options     |
| Current vs new branch          | Current branch plus checkout choices            |
| Stash before checkout          | Stash or stop                                   |
| YouTrack / destructive confirm | Name the exact external action                  |
| Compare N approaches           | Approach labels and concise tradeoffs           |
| Plan execution handoff         | Saved plan path plus execution choices          |
| Generic yes/no                 | Specific action, Yes and No                     |

One question per `AskQuestion` call when possible.

### Superpowers writing-plans override

After a plan is saved, do **not** print “Two execution options” in chat. Call Cursor `AskQuestion` directly with the saved plan path and Subagent-driven, Inline execution, and Workflow handoff (`/wf-handoff`) options.

### No worktrees (HARD-GATE)

**Overrides** Superpowers `using-git-worktrees` and old handoff contracts.

- **NEVER** `using-git-worktrees`, **NEVER** `git worktree`
- In-place checkout only: `feature/*` or `bugfix/*` via `workflow_resolve_branch` + `workflow_branch_setup`
- Dirty tree before checkout → `stash_choice` AskQuestion → `workflow_branch_setup` with `stash: yes|no`
- After implementation, if manifest has `stash_ref` → AskQuestion → `reapply_stash`

---

## Presentation — flows & UI (tools-first)

| Content                               | Tool                                     | Output                                                 |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Process / architecture flow           | `workflow_present_flow`                  | mermaid `flowchart` — render in fenced `mermaid` block |
| UI wireframe, layout, view comparison | `workflow_present_ascii`                 | ASCII box drawing — show in fenced `text` block        |
| 5 layout options                      | `workflow_present_ascii` once per option | numbered wireframes from tool                          |

**NEVER** hand-draw ASCII wireframes or mermaid in chat without calling the tool first.
**UI brainstorming:** describe rows/fields/buttons in JSON spec → `workflow_present_ascii` → show result.
**Complex flows:** nodes + edges JSON → `workflow_present_flow` → mermaid block.

Example ASCII spec:

```json
{
  "title": "Dashboard — opción A",
  "rows": [
    { "type": "header", "label": "Toolbar" },
    {
      "type": "columns",
      "columns": [{ "label": "Nav" }, { "label": "Content" }]
    },
    { "type": "button", "label": "Guardar" }
  ]
}
```

---

## Plugin setup

First-time or missing config: `/wf-init` scaffolds files; edit `~/.config/workflow-toolkit/youtrack.token` (replace `YOUR_TOKEN_HERE`). Then `/wf-status` to verify. Never paste token in chat.
