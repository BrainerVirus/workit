# Spec: Project hygiene files — validation + ensure

**Branch:** `feature/hygiene`

## Context

The toolkit validates workflow docs (`docs/<slug>/`) and enforces `docs/*/sdd/` gitignore, but project hygiene files are unvalidated and uncreated: CHANGELOG.md (Keep a Changelog format, the defined standard), README.md, .editorconfig, .gitattributes, and (for open-source repos) LICENSE + CONTRIBUTING.md. The toolkit's own repo lacks a CHANGELOG.md — the rule is not self-enforced.

Goal: detect hygiene file state in `workflow_docs_validate` and `workflow_verify`, and let `wf-init` create missing files with sensible templates (never overwriting existing ones).

## Goals

1. **`src/core/hygiene.ts`**: `hygieneFiles(workspaceRoot)` returns per-file state (`missing | invalid | ok`) for `CHANGELOG.md`, `README.md`, `.editorconfig`, `.gitattributes`, plus optional `LICENSE`/`CONTRIBUTING.md` flagged `openSourceOnly`.
2. **CHANGELOG format check**: reuse `changelogUnreleasedStats` — a valid Keep a Changelog file has `## [Unreleased]` and at least one category section (Added/Changed/Fixed/Removed/Security/Deprecated). Missing file → `changelog_missing`; bad format → `changelog_invalid_format`.
3. **Validation findings** (warnings, not hard): `changelog_missing`, `changelog_invalid_format`, `readme_missing`, `editorconfig_missing`, `gitattributes_missing`, and open-source-only `license_missing`, `contributing_missing` (heuristic: repo has a LICENSE file, or `package.json` with `private: false`, or is the toolkit repo).
4. **`workflow_verify`**: adds a `CHANGELOG.md` format check (reuses `changelogUnreleasedStats`).
5. **`ensureHygieneFiles(workspaceRoot, { confirmed, includeOpenSource })`**: creates missing files from `templates/hygiene/` templates; never overwrites existing; requires `confirmed`.
6. **`workflow_toolkit_init_apply`** gains `action: "hygiene"` (or extends `gitignore`) on both platforms; `wf-init` skill documents it.

## Non-goals

- Validating README content (only existence).
- Forcing LICENSE/CONTRIBUTING on non-open-source repos.
- Migrating existing malformed changelogs (validator flags; user fixes).

## Architecture

### 1. `src/core/hygiene.ts`

```typescript
export type HygieneFile = "CHANGELOG.md" | "README.md" | ".editorconfig" | ".gitattributes" | "LICENSE" | "CONTRIBUTING.md";
export type HygieneState = Record<HygieneFile, "missing" | "invalid" | "ok" | "skip">;

export const hygieneFiles = (workspaceRoot: string): HygieneState & { openSource: boolean };
export const ensureHygieneFiles = (
  workspaceRoot: string,
  opts: { confirmed: boolean; includeOpenSource?: boolean },
): { ok: true; created: string[] } | { ok: false; error: string };
```

- `openSource` heuristic: exists `LICENSE`, or `package.json` `private !== true`, or the dir name is `workflow-toolkit`.
- `invalid` applies only to CHANGELOG.md (format via `changelogUnreleasedStats`).
- Templates read from `templates/hygiene/`.

### 2. Templates (`templates/hygiene/`)

- `CHANGELOG.md`: `# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n`
- `README.md`: `# <dir name>\n\n<!-- Describe the project -->\n`
- `.editorconfig`: `root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\nindent_style = space\nindent_size = 2\n`
- `.gitattributes`: `* text=auto\n*.md text\n*.bat text eol=crlf\n`
- `LICENSE`: MIT template placeholder (with `<YEAR>`/`<HOLDER>`)
- `CONTRIBUTING.md`: short contribution guide placeholder

### 3. Validation findings

In `docsValidate` (src/core/docs-validate.ts), after the sdd check, add hygiene findings (warnings) via `hygieneFiles(cwd)`:

```typescript
const hygiene = hygieneFiles(cwd);
if (hygiene["CHANGELOG.md"] === "missing") quality.push({ code: "changelog_missing", message: "...", severity: "warning" });
if (hygiene["CHANGELOG.md"] === "invalid") quality.push({ code: "changelog_invalid_format", message: "...", severity: "warning" });
// ... readme_missing, editorconfig_missing, gitattributes_missing
if (hygiene.openSource && hygiene.LICENSE === "missing") quality.push({ code: "license_missing", ... });
if (hygiene.openSource && hygiene["CONTRIBUTING.md"] === "missing") quality.push({ code: "contributing_missing", ... });
```

### 4. `workflow_verify`

Add a check in `scripts/verify-project.sh`: CHANGELOG.md exists and parses (`changelogUnreleasedStats`-style python check or the TS core via a small script). Simplest: a shell check that CHANGELOG.md exists and contains `## [Unreleased]`.

### 5. `workflow_toolkit_init_apply` `hygiene` action

Both platforms: `action: "hygiene"` (plus optional `include_open_source: boolean`) → `ensureHygieneFiles(context.directory, { confirmed, includeOpenSource })`.

## Data flow

1. User runs `wf-init` → config + gitignore + hygiene (creates missing files).
2. `workflow_docs_validate` on any feature → hygiene findings listed (warnings).
3. `workflow_verify` → CHANGELOG format check.
4. Open-source repos → LICENSE/CONTRIBUTING flagged/created when opted in.

## Error handling

- `ensureHygieneFiles`: read templates; on missing template, skip that file (never fail); on write error, return the error.
- Non-git dir: hygiene works on the filesystem (no git needed).
- Never overwrite existing files (only create missing).

## Verification

- `hygieneFiles` tests: all-missing → all missing; valid changelog → ok; malformed changelog → invalid; openSource heuristic (LICENSE present, private:false, toolkit dir).
- `ensureHygieneFiles` tests: creates missing from templates; preserves existing; requires confirmed; skip on missing template.
- `docsValidate` findings tests: changelog_missing/invalid_format, readme_missing, editorconfig/gitattributes, license/contributing when openSource.
- `verify` test: shell check passes/fails on changelog presence+format.
- `init_apply` hygiene action test on both platforms.
- `bun run check` green.

## Compatibility

- Existing repos: findings are warnings (no hard break); wf-init fixes.
- Existing changelogs: untouched (validator flags only).
- Cursor/OpenCode parity for the new action.

## Out of scope (tracked separately)

- Spec 9: open-source packaging (npm, marketplace, badges).
- README content validation.
