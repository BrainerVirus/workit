# Spec: Multi-user toolkit configuration — assisted init, locale, templates, rules, branch policy

**Branch:** `feature/toolkit-config`

## Context

The toolkit currently hardcodes the user's personal defaults: YouTrack instance (`enghouseamg.youtrack.cloud`), meeting issues (`IRPT-12`), mention (`Alejandra.Flores`), timezone (`America/Santiago`), locale (`es-CL`), the four Cursor `.mdc` rules, and the branch policy (`feature/*|bugfix/*` + protected `main|develop`). Another user cannot adopt it without editing repo files; and using `/wf-issue-update` (es-CL) flips the whole session's language because the template does not declare its own locale.

Goal: make everything user-configurable from `~/.config/workflow-toolkit/` with a single canonical entry point per concern, translated to each platform's native format (Cursor `.mdc`, OpenCode bootstrap contract), plus an assisted `wf-init` wizard so any user can set it up — including a configurable branch policy with recognized presets.

## Goals

1. **Assisted `wf-init`**: interactive wizard (native questions) that configures VCS provider, YouTrack (baseUrl, meeting issue, mention), and locale (BCP-47 combobox with validation); detects existing config and offers migration vs fresh setup; writes `config.json`, `youtrack.json`, `vcs.json`; copies default templates and rules into the config dir.
2. **Locale**: global `config.json: { locale }` (default `en`) governs agent/toolkit language. YouTrack issue templates carry their own `locale: "es-CL"` (in the template file) and the `/wf-issue-update` command instructs the model to keep answering the user in `config.locale` while producing es-CL issue content — the session language does not flip.
3. **Editable templates**: issue-update, greeting, and headers templates copied to `~/.config/workflow-toolkit/templates/`; new `workflow_template_edit` tool edits them with agent assistance; YouTrack tools read templates from config with fallback to repo defaults.
4. **Canonical rules, multi-platform**: rules live in `~/.config/workflow-toolkit/rules/<name>/rule.md` (canonical frontmatter: `name`, `description`, `platforms`, markdown body). A compiler (`src/core/rules.ts`) translates them: → Cursor `.mdc` (description + alwaysApply) via sync-runtime; → OpenCode contract sections injected by the bootstrap. New `workflow_rule_list` / `workflow_rule_edit` tools. Repo defaults remain the base; user rules override.
5. **Branch policy**: `config.json: { branchPolicy: { preset, allowed, protected } }` with presets `gitflow` (default; `feature/*`, `bugfix/*`, `hotfix/*`, `release/*`; protected `main|develop|master|prod`), `github-flow` (short-lived branches; protected `main`), `trunk-based` (protected `main`), and `custom` (explicit `allowed`/`protected` regex lists). Branch tools (`resolveBranch`, `docsBranch`, `branchSetup`, `docsValidate`) read the policy with fallback to `gitflow`.

## Non-goals

- Changing the deterministic gates (flow, quality, docs validation) — those are code, not user rules.
- Git-flow binary integration (user keeps using the `git flow` binary manually).
- Per-command locales (single global locale + es-CL YouTrack templates only).
- Cloud sync / profiles across machines.

## Architecture

### 1. Config layout

```
~/.config/workflow-toolkit/
├── config.json          ← locale, timezone, branchPolicy, localeOptions
├── youtrack.json        ← existing (baseUrl, meeting issues, mention, headers)
├── vcs.json             ← existing (provider, hosts, tokens)
├── docs-repo.json       ← existing (Spec 5)
├── templates/
│   ├── issue-update.md  ← es-CL content template (locale declared inside)
│   ├── greeting.md
│   └── headers.md
└── rules/
    └── <name>/rule.md   ← canonical rule (frontmatter + markdown body)
```

### 2. `config.json` schema

```json
{
  "locale": "en",
  "localeOptions": ["en", "es-CL", "es-MX", "es-AR", "pt-BR"],
  "timezone": "America/Santiago",
  "branchPolicy": {
    "preset": "gitflow",
    "allowed": ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
    "protected": ["main", "develop", "master", "prod"]
  }
}
```

`locale` validated against `/^[a-z]{2,3}(-[A-Z]{2})?$/`. `branchPolicy.preset` one of `gitflow|github-flow|trunk-based|custom`; when `custom`, `allowed`/`protected` are authoritative; otherwise preset defaults are used (still overridable via the fields).

### 3. Assisted init (`wf-init`)

`workflow_toolkit_init_apply` grows a guided mode: instead of env-only defaults, it asks (native questions, one at a time):

1. New setup or migrate existing config? (detects existing files)
2. VCS provider: GitHub / GitLab (custom allowed)
3. YouTrack baseUrl (default empty → ask; offer the user's known instance as an option when migrating)
4. Meeting issue id + default mention (migrate keeps current values)
5. Locale combobox: BCP-47 options from `localeOptions` + custom field (validated)
6. Branch policy preset: gitflow / github-flow / trunk-based / custom

Writes all config files; copies `templates/` and `rules/` defaults from the repo when absent. `confirmed: true` required for writes.

### 4. Locale in commands

- `config.locale` is injected into the bootstrap contract (one line: "Answer the user in `{locale}` unless a template declares otherwise").
- `templates/issue-update.md` frontmatter declares `locale: es-CL` and its body says the issue content is es-CL; the `/wf-issue-update` command template tells the model: "issue content is es-CL; respond to the user in the session locale (config.locale)".
- Greeting/headers templates read `youtrack.json` fields as today (they are content-only).

### 5. Template editing

`workflow_template_edit { name, confirmed }` — names: `issue-update|greeting|headers`. Reads the current template (config path, fallback repo), lets the agent apply user-driven edits, writes back to config, returns the diff. `workflow_template_list` lists available templates and their source (config vs repo default).

YouTrack tools (`workflow_youtrack_draft`, `context`) read `templates/issue-update.md` / `greeting.md` / `headers.md` from config when present, else repo templates. The `commentHeader`/`attachmentsHeader*` fields in `youtrack.json` become legacy (templates supersede them; keep reading them as fallback for compat).

### 6. Canonical rules + compiler

Canonical rule file `rules/<name>/rule.md`:

```markdown
---
name: no-worktrees
description: NEVER use git worktrees
platforms: [cursor, opencode]
---
# No worktrees (HARD-GATE)

**Overrides** ... (markdown body)
```

`src/core/rules.ts`:
- `listRules(root, configDir)`: merges repo defaults (`rules/` in the toolkit) with user rules (config dir) — user wins by name.
- `compileRuleCursor(rule)`: generates `.mdc` with frontmatter `description` + `alwaysApply: true` + body.
- `compileRuleOpenCode(rule)`: generates a contract section (heading + body) appended to the bootstrap injection.
- `writeCompiledCursorRules(configDir, targetDir)`: called by sync-runtime to emit `.mdc` files into the Cursor plugin rules dir.
- Bootstrap (`src/bootstrap.ts`) reads `contract.md` (config) if present, else the repo template — and appends compiled OpenCode sections for user rules.

Tools:
- `workflow_rule_list`: lists merged rules (name, platform targets, source).
- `workflow_rule_edit { name, confirmed }`: opens the canonical file (config copy; creates from repo default on first edit), applies agent-assisted edits, writes back; compiler artifacts regenerate on next sync/bootstrap.

### 7. Branch policy in tools

`src/core/branch.ts` gains `resolveBranchPolicy(configDir)`: reads `config.json` `branchPolicy`, falls back to `gitflow` defaults. `BRANCH_PAT` / `PROTECTED` constants become policy-driven: `allowed` patterns (converted to regex, `*` → `[^/]*`), `protected` list. Used by `resolveBranch`, `docsBranch`, `branchSetup`, and `docsValidate` (branch check). A `codex/feature/x` branch is rejected under `gitflow` but allowed under a custom policy listing it.

## Data flow

1. User runs `wf-init` → wizard → config written (migration keeps values).
2. Templates + rules copied to config (if absent).
3. Sync-runtime compiles canonical rules → `.mdc` for Cursor; bootstrap compiles → contract sections for OpenCode.
4. User edits templates/rules via `/wf-template-edit`, `/wf-rule-edit` → files in config updated.
5. Tools read config for locale, templates, branch policy; deterministic gates unchanged.

## Error handling

- Missing `config.json`: all readers fall back to current defaults (en, gitflow) — toolkit still works for existing setups.
- Invalid locale: init rejects with the BCP-47 pattern message; runtime readers fall back to `en`.
- Unknown branch preset: falls back to `gitflow` with a warning in the tool result.
- Missing template in config: fallback to repo template (never hard-fail).
- Rule with unknown platform: compiler skips it and reports it in `workflow_rule_list`.
- `confirmed: false` on any write tool: existing "confirmed: true required" error.

## Verification

- Config tests: write/read `config.json` (locale validation, branch policy presets and custom).
- Init tests: migration path keeps existing values; fresh path writes defaults; locale combobox validation.
- Compiler tests: canonical rule → `.mdc` (frontmatter) and → contract section (heading+body); user rule overrides repo default by name.
- Template tests: `workflow_template_edit` writes to config, tools read config with repo fallback.
- Branch policy tests: `gitflow` rejects `codex/feature/x`; custom policy allows it; `docsValidate` branch check uses the policy.
- Locale test: bootstrap contract includes `config.locale`; issue-update template declares es-CL.
- `bun run check` green; both platforms expose the new tools.

## Compatibility

- Existing user config (youtrack.json, vcs.json, docs-repo.json) untouched; `config.json` is additive.
- Existing branch behavior unchanged under default `gitflow` preset.
- Repo default rules/templates remain the base; user overrides additive.
- `commentHeader`/`attachmentsHeader*` in youtrack.json still honored as fallback (legacy).

## Out of scope (tracked separately)

- Cloud sync / profiles.
- Per-command locales.
- Git-flow binary automation.
- Migrating rules currently embedded in skills (skills are code-owned).
