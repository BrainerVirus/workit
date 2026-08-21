# Spec: Docs repo — link, list, and promote specs

**Branch:** `feature/docs-repo`

## Context

Quality specs (Spec 4) live in `docs/<slug>/` of the working repo. When a feature spans several repos or must become cross-cutting standard documentation, it should be promoted to the component's docs repo — e.g. `bulkload/docs/features/2026-05-service-load/` with `README.md` (summary, affected repos, status table) + `spec.md` + `plan.md`, indexed in `features/README.md`. Today that promotion is manual and unguarded.

Goal: link the docs repo in the toolkit config (no files polluting the working repo), list local specs with promotion status, and promote selected specs into the docs repo in the established format — only after the quality gate passes.

## Goals

1. `workit_docs_repo_link { path, confirmed }` — store the docs repo path in `~/.config/workflow-toolkit/docs-repo.json`; validate the path exists, is a git repo, and has (or can create) `features/`.
2. `workit_docs_list` — list `docs/*/spec.md` in the working repo with `{ slug, promoted, target }` where `promoted` = a matching `features/*/<slug>/` exists in the docs repo.
3. `workit_docs_promote { slug, confirmed, force? }` — copy `spec.md` + `plan.md` (if present) into `<docs-repo>/features/YYYY-MM-<slug>/`, generate the feature `README.md` (summary from spec Context/Goals, affected-repos section, status table), and add/update the row in `<docs-repo>/features/README.md` index.
4. Quality gate: promote refuses unless `docsValidate` passes AND `qualitySpec` has no hard findings, unless `force: true`.
5. Promotion writes files only — never commits, never pushes (the user owns git in the docs repo).
6. Idempotent: re-promoting the same slug updates files and the index row without duplication.

## Non-goals

- Pushing/PRs in the docs repo.
- ADR or runbook templates (features only).
- Auto-detecting the docs repo from git remotes (explicit link only).
- Migrating existing `docs/superpowers/` artifacts (legacy tree is user-side cleanup).

## Architecture

### 1. Config link

`~/.config/workflow-toolkit/docs-repo.json`:

```json
{ "path": "/home/cristhofer/.../bulkload/docs" }
```

Read/write follows the existing config pattern (`WORKFLOW_DOCS_REPO_CONFIG` env override, default `$XDG_CONFIG_HOME|$HOME/.config/workflow-toolkit/docs-repo.json`). A `tools/docs-repo.ts` module in `src/core/` owns: `readDocsRepoConfig()`, `writeDocsRepoConfig()`, `docsRepoPath(workspaceRoot)`.

### 2. Tools (registered in OpenCode plugin + Cursor MCP)

- `workit_docs_repo_link({ path, confirmed })`:
  - requires `confirmed: true`;
  - validates `path` exists + is a git repo (`git -C path rev-parse`) + `features/` exists or is created;
  - writes config; returns `{ path, ok: true }`.
- `workit_docs_list()`:
  - scans `docs/*/spec.md` in the working repo;
  - for each slug, checks `<docs-repo>/features/*/<slug>/` (basename match on dir);
  - returns `{ docs_repo, specs: [{ slug, promoted, target }] }`.
- `workit_docs_promote({ slug, confirmed, force? })`:
  - gate: `docsValidate(spec, plan)` must pass; `qualitySpec(specText)` must have zero hard findings (unless `force: true`);
  - copies `docs/<slug>/spec.md` (+ `plan.md` if exists) into `features/YYYY-MM-<slug>/` (month = current date);
  - generates `README.md` (title from `# Spec:` line, summary from `## Context` first paragraph, affected repos from any `**Repos:**` line or blank, status table);
  - updates `features/README.md` index (row `<slug> | <repos> | Spec en revisión`; replace existing row for the slug);
  - never commits; returns `{ slug, target_dir, files: [...], index_updated: true }`.

### 3. README generation

Feature README skeleton:

```markdown
# Feature: <slug>

**Fecha:** YYYY-MM
**Estado:** Spec en revisión
**Repos afectados:** <from spec **Repos:** line, or "—">

## Resumen

<first paragraph of ## Context from spec.md>

## Documentación

| Documento | Contenido |
| --- | --- |
| [spec.md](./spec.md) | Especificación completa |
| [plan.md](./plan.md) | Plan de implementación |
```

Index row appended/updated in `<docs-repo>/features/README.md` table:

```markdown
| [<slug>](./YYYY-MM-<slug>/) | <repos> | Spec en revisión |
```

## Data flow

1. User runs `workit_docs_repo_link { path }` once → config written.
2. User runs `workit_docs_list` → sees local specs and promotion status.
3. User runs `workit_docs_promote { slug }` → gate runs → files copied + README + index updated.
4. User reviews the docs repo changes and commits them manually.

## Acceptance criteria

- CA-01: `workit_docs_repo_link` with `confirmed` validates the path (exists, git repo, `features/` present or creatable) and writes `docs-repo.json`; invalid path → error, no write.
- CA-02: `workit_docs_list` returns `{ slug, promoted, target }` for every `docs/*/spec.md`, where `promoted` = a matching `features/*/<slug>/` dir exists in the docs repo.
- CA-03: `workit_docs_promote` copies `spec.md` (+ `plan.md` if present) into `features/YYYY-MM-<slug>/`, generates the feature `README.md`, and adds/updates the `features/README.md` index row.
- CA-04: Promote refuses when `docsValidate` fails or `qualitySpec` has hard findings; `force: true` bypasses the gate.
- CA-05: Promotion writes files only — never commits, never pushes.
- CA-06: Re-promoting the same slug updates files and the index row without duplication.

## Error handling

- Missing config or unlinked docs repo: `workit_docs_list` / `promote` return `{ error: "docs repo not linked — run workit_docs_repo_link" }`.
- Invalid link path: link returns `{ error }` and does not write config.
- Missing spec file for slug: promote returns `{ error: "docs/<slug>/spec.md not found" }`.
- Quality gate failure: promote returns `{ error, findings }` listing hard findings; `force: true` bypasses.
- Index file missing: promote creates `features/README.md` with header + the new row.

## Verification

- Tests with a temp docs-repo (git init + `features/`): link → list → promote → assert structure (`features/YYYY-MM-<slug>/{README.md,spec.md,plan.md}`), index updated, re-promote idempotent.
- Gate test: spec with hard findings (missing section) → promote refuses without `force`, passes with `force`.
- Missing-config test: list/promote before link → error.
- `bun run check` green.

## Compatibility

- Existing config files in `~/.config/workflow-toolkit/` unaffected (new file `docs-repo.json`).
- Specs promoted from the new `docs/<slug>/` layout only (legacy layout not supported).
- No changes to existing tools.

## Out of scope (tracked separately)

- Auto-detecting the docs repo from remotes.
- ADR/runbook promotion.
- Push/PR automation for the docs repo.
