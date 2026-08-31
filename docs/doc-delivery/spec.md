# Spec: Clickable doc delivery + SDD gitignore enforcement

**Branch:** `feature/doc-delivery`

## Context

When the agent delivers a spec or plan, it references the file as `` `docs/<slug>/spec.md` `` in backticks — not clickable in OpenCode, and the content is not visible. Confirmed in session `ses_0227dc417ffeqLhBcU3UX5Ze7l` ("Spec is at `docs/upgrade-angular-19-2-25/spec.md`. Please review it..."). The user must open the file manually and re-read it.

Separately, SDD state (`docs/<slug>/sdd/`) is meant to be gitignored working state, but projects that never ran `wf-init` lack the gitignore entry — observed in `aux-tables/mfe` where `docs/upgrade-angular-19-2-25/sdd/` exists untracked-but-unignored. This matters more with the docs-repo promotion feature (Spec 5): promoting a spec whose sdd is committed defeats the working-state model.

Goal: (1) teach the agent to deliver docs as clickable markdown links with a content summary; (2) detect backtick-only references and correct them; (3) enforce `docs/<slug>/sdd/` gitignore in projects via `wf-init` and validation gates.

## Goals

1. **Clickable delivery rule**: the contract reminder (Spec 7) gains one line — "Deliver specs/plans as `[spec.md](docs/<slug>/spec.md)` markdown links plus a 3-5 bullet summary (Context, Goals, key decisions, status)." The brainstorming/wf-implement skills' user-review sections repeat it.
2. **Backtick-ref detector**: `detectBacktickDocRefs(text)` in `src/core/detector.ts` — matches `` `docs/<path>.md` `` occurrences without a markdown link `[` in the same message. The Spec 7 hook injects a correction into the next turn: "Deliver with a clickable markdown link and summarize the content."
3. **SDD gitignore validation**: `workit_docs_validate` reports `sdd_not_ignored` (hard) when `docs/<slug>/sdd/` exists and `git check-ignore` does not cover it. `workit_docs_promote` (Spec 5) requires the sdd dir be ignored.
4. **Minimal project gitignore via wf-init**: when setting up a project, ensure `.gitignore` contains `docs/*/sdd/` plus common non-shared entries (`.DS_Store`, `Thumbs.db`, `*.swp`, `.idea/`, `.vscode/`, `.env`, `node_modules/`, `dist/`, `*.log`, `.cache/`). Only append missing lines; never overwrite an existing `.gitignore`. Requires `confirmed`.

## Non-goals

- Changing OpenCode's link rendering (native).
- Enforcing gitignore server-side (git is the tool).
- Migrating already-committed sdd dirs (user-side cleanup; the validator flags them).

## Architecture

### 1. Reminder line

In `src/core/reminder.ts`, `REMINDER_TEXT` gains:

```markdown
- Delivering docs → clickable markdown link `[spec.md](docs/<slug>/spec.md)` + 3-5 bullet summary.
```

The full contract (`templates/superpowers-doc-contract.md`) gains the same line under a "## Doc delivery" section.

### 2. Detector: `detectBacktickDocRefs`

```typescript
export const detectBacktickDocRefs = (text: string): string[] | null => {
  const backtickRefs = [...text.matchAll(/`docs\/[^`\s]+\.md`/g)].map((m) => m[0]);
  if (!backtickRefs.length) return null;
  if (/\[[^\]]+\]\(docs\//.test(text)) return null; // has a markdown link already
  return backtickRefs;
};
```

Hook (Spec 7 mechanism): after prose-choice detection, also check `detectBacktickDocRefs(lastAssistantText)` and inject a doc-delivery correction (distinct `<workflow-doc-delivery>` marker).

### 3. `sdd_not_ignored` validation

In `src/core/docs-validate.ts`, after existing checks: if `docs/<slug>/sdd` exists (slug derived from spec path), run `git check-ignore docs/<slug>/sdd/<file>` (via `execFileSync`); if not ignored → hard finding `sdd_not_ignored` with the fix message.

`workit_docs_promote` (`src/core/docs-repo.ts`): before copying, if the sdd dir exists and is not ignored, refuse with the same message unless `force`.

### 4. wf-init gitignore

In the `config` action of `workit_init_apply` (or a dedicated `gitignore` action): ensure the workspace `.gitignore` contains the entries. Read existing; append missing lines; write back. Requires `confirmed`. The entry list:

```gitignore
# workflow-toolkit: SDD working state (never commit)
docs/*/sdd/

# OS / editor cruft
.DS_Store
Thumbs.db
*.swp
.idea/
.vscode/
.env
node_modules/
dist/
*.log
.cache/
```

## Data flow

1. Agent writes spec → delivers with `[spec.md](docs/...)` + summary (reminder enforces).
2. If it uses backticks only → next turn gets the doc-delivery correction.
3. Project setup via wf-init → `.gitignore` gains the entries → sdd stays untracked.
4. `workit_docs_validate`/`promote` flag sdd dirs that are not ignored.

## Acceptance criteria

- CA-01: `REMINDER_TEXT` (and the full contract template) includes the clickable-delivery line — `[spec.md](docs/<slug>/spec.md)` + 3-5 bullet summary; the brainstorming/wf-implement skills' user-review sections repeat it.
- CA-02: `detectBacktickDocRefs` matches backtick-only `` `docs/<path>.md` `` refs; returns null when a markdown link exists in the same message or there are no refs.
- CA-03: `workit_docs_validate` reports a hard `sdd_not_ignored` finding when `docs/<slug>/sdd/` exists and is not gitignored; `workit_docs_promote` refuses unless the sdd dir is ignored or `force: true`.
- CA-04: wf-init appends the missing `.gitignore` entries (`docs/*/sdd/` + common cruft) without duplicating lines or overwriting existing custom entries; requires `confirmed`.

## Error handling

- Detector/hook: same try/catch no-op pattern as Spec 7.
- gitignore write: read-modify-write; on read failure treat as empty (no existing file); never throw.
- check-ignore failure (not a git repo): treat as not-ignored with the fix message (repo must be git for workflow docs anyway).

## Verification

- Detector tests: backtick refs detected; markdown link present → no detection; no docs refs → null.
- Hook tests: correction injected when backtick-only; not when markdown link used.
- Reminder/contract tests: new line present.
- `sdd_not_ignored`: temp git repo with and without gitignore entry → hard finding only when not ignored.
- Promote: refuses when sdd not ignored; passes when ignored or `force`.
- wf-init gitignore: appends missing entries; does not duplicate; does not overwrite existing custom entries.
- `bun run check` green.

## Compatibility

- Existing projects without the gitignore entry: validator flags them; wf-init fixes.
- Existing `.gitignore` files: untouched except appended missing lines.
- Cursor: delivery rule added to the session-start reminder (prose); detection OpenCode-only (asymmetric, documented).

## Out of scope (tracked separately)

- Spec 9: open-source packaging (npm publish, marketplace, CI/CD, badges).
- Migrating committed sdd dirs.
