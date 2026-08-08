# Spec: Rebrand workit — @brainervirus/workit, wk-* entry points

**Branch:** `feature/rebrand-workit`

## Context

The npm name `flowkit` is blocked by npm's anti-squatting rule (too similar to the existing `flow-kit`); the user prefers the `workit` wordplay (work + kit) and wants the entry points renamed from `wf-*` to `wk-*`. The plain `workit` name is taken (v2.1.0), so the package ships as `@brainervirus/workit` (verified free). This spec renames EVERYTHING: package identity, bin, skills, commands, identifiers, texts, cursor plugin, docs, README — and keeps the toolkit fully functional, then releases 0.5.0 under the new names (core, opencode, cursor, cli).

## Goals

- G1: `package.json`: `name: "@brainervirus/workit"`, `bin: { "workit": "./src/cli/index.tsx" }` (scoped package, public access — `publishConfig.access: "public"` already present), description/keywords updated.
- G2: All 12 skills + 12 commands renamed `wf-*` → `wk-*` (file names, YAML frontmatter names, references in src/plugin.ts descriptions, cursor plugin registration).
- G3: `src/` identifiers/texts: `workflow-toolkit` → `workit`, `wf-` → `wk-` in user-facing strings, tool descriptions, error messages, and internal names where they surface in output; functional internal identifiers (functions/types) stay unless they leak into UX.
- G4: Cursor plugin: plugin.json, mcp.json, rules, hooks paths and names updated; run-server.sh fallbacks (`~/.local/share/workflow-toolkit` → `~/.local/share/workit`).
- G5: `docs/` + README + CONTRIBUTING + templates: all `workflow-toolkit`/`wf-` references updated; the wf-* skill references inside specs are updated where they describe the entry points.
- G5b: Code-review check via **opencode GitHub integration** (verified at https://opencode.ai/docs/github/): the user installed the GitHub App (`github.com/apps/opencode-agent`) on all repos; workflows use `anomalyco/opencode/github@latest` with the **`opencode-go/deepseek-v4-flash`** model (verified on models.dev — the user's plan). `pull_request` events review each PR (custom prompt enforcing workit's own standards — the enforcement rails as review criteria); `issue_comment` + `pull_request_review_comment` allow `/oc`-driven fixes; `issues` triage. Some flows BLOCK merge (required checks), others are advisory — decided flow-by-flow in the plan. Cursor Bugbot stays an optional documented alternative.
- G6: The user's live config (`~/.config/workflow-toolkit/`) is NOT renamed (config dir stability — optional alias note in README).
- G7: Monorepo restructure (bun workspaces) with SEPARATE publishes per platform: `packages/workit-core` (shared: skills, commands, vendor/superpowers, templates, core TS — `@brainervirus/workit-core`), `packages/workit-opencode` (the opencode plugin — `@brainervirus/workit-opencode`), `packages/workit-cursor` (the cursor plugin: mcp + hooks + rules + marketplace manifest — `@brainervirus/workit-cursor`), `packages/workit-cli` (the Ink TUI — `@brainervirus/workit-cli`, user's `-cli` choice). Each platform package is thin over the core (the model: ponytail ships one plugin on npm; superpowers is vendored — our platforms share the core but publish separately, enabling the cursor marketplace).
- G8: GitHub repo renamed `workflow-toolkit` → `workit` (user asked — repo, releases, and docs references all updated; remote URLs in README/package.json updated).
- G9: Release automation with semantic-release (Conventional Commits): automated version bump, changelog, tags, and ordered publish of the packages (core → platform plugins → cli); replaces the manual release.yml flow.
- G9b: Auto-update story documented: opencode does NOT auto-update npm plugins (ponytail stays at its pinned version until the pin changes); superpowers auto-updates because it's vendored with a sync script. Workit: (a) the existing `sync-runtime.sh` keeps the dev install fresh, (b) consumers pin `latest` (opencode re-resolves on restart) or run the sync script — documented in README.
- G10: 0.5.0 released under the new names: tag, GitHub Release, `npm publish` of the four packages in order (core → opencode → cursor → cli) (secret configured).
- G11: Python dependency eliminated: all 25 `.sh` scripts with embedded `python3` heredocs AND the changelog `.py` are ported to pure TS executed by bun (`runScript` invokes a TS binary); README removes the Python 3 prerequisite entirely (the "required only for wk-changelog" note is stale — python3 is embedded in 25 scripts: youtrack/config.sh, vcs/config.sh, pr-create.sh, verify-token.sh, token-create-urls.sh, etc.).
- G12: Tests restructured by package: `test/workit-core/**`, `test/workit-opencode/**`, `test/workit-cursor/**`, `test/workit-cli/**`, `test/shared/**` mirroring the packages/ tree; CI runs a check job PER PACKAGE (clear per-category results), replacing the single flat test/ dir.

## Non-goals

- No renaming of `~/.config/workflow-toolkit/` or `WORKFLOW_TOOLKIT_CONFIG*` env vars (stability of existing installs; documented).
- No functional refactor of internal code beyond the rename + workspace split.
- No git history rewrite.
- No toolkit code for the code-review check (Bugbot is external SaaS activated in the Cursor dashboard).

## Architecture

```mermaid
flowchart LR
  %% Spec: rebrand workit — @brainervirus/workit, wk-* entry points
  pkg["package.json"]
  bin["Bin + commands"]
  skills["Skills wf-* → wk-*"]
  src["src/ código"]
  cursor["cursor/ plugin"]
  docs["docs/ + README"]
  verify["Verify"]
  publish["Release 0.5.0"]
  pkg -->|name @brainervirus/workit| bin
  bin -->|wk-* entry points| skills
  skills -->|wf-* → wk-* (12+12)| src
  src -->|identifiers + textos| cursor
  cursor -->|mcp/rules/hooks| docs
  docs -->|specs + README| verify
  verify -->|bun check + pack dry-run| publish
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| Package names | `@brainervirus/workit-core`, `@brainervirus/workit-opencode`, `@brainervirus/workit-cursor`, `@brainervirus/workit-cli` (all scoped, public access) |
| Bin | `workit` (the CLI entry; the `wk` shorthand is for the agent-facing commands/skills) |
| CI model | `opencode-go/deepseek-v4-flash` (verified on models.dev) |
| Review app | opencode GitHub App (github.com/apps/opencode-agent — installed by the user) |
| Entry points | `wk-*` (12 skills + 12 commands), e.g. `wk-init`, `wk-pr`, `wk-implement` |
| Config dir | `~/.config/workflow-toolkit/` UNCHANGED (stability; README documents the alias) |
| Env vars | `WORKFLOW_TOOLKIT_CONFIG*` UNCHANGED (documented) |
| Release | 0.5.0 → `@brainervirus/workit-core@0.5.0` (core, opencode, cursor, cli publish in order) |

## Acceptance criteria

- CA-01: `npm pack --dry-run` shows `@brainervirus/workit` with `bin.workit`; tarball sane (<2MB, no node_modules).
- CA-02: Zero remaining `wf-` entry-point references in skills/, commands/, and src/plugin.ts descriptions (grep gate — the existing "no docs/superpowers paths" style test extended or a new grep gate).
- CA-03: `wk-*` skills/commands load: plugin registration test asserts the 12 `wk-` names; cursor plugin.json/mcp.json reference the new names.
- CA-04: `bun run check` green; cursor MCP smoke test still answers tools/list; the user's config dir/env still resolve (no rename touched them).
- CA-05: README/CONTRIBUTING/templates have zero stale `workflow-toolkit`/`wf-` references (grep gate); install section shows `npm i @brainervirus/workit-opencode` + `npx workit init`.
- CA-06: Monorepo: `bun install` at the root resolves all four packages; workit-opencode + workit-cursor + workit-cli each have their own package.json (thin over `@brainervirus/workit-core`); root scripts delegate to all.
- CA-07: GitHub repo renamed to `workit`; `git remote get-url origin` resolves; README badges/URLs updated; no stale `workflow-toolkit` repo-name references in README/CONTRIBUTING (grep gate).
- CA-08: semantic-release config present (release config with Conventional Commits); dry-run produces the expected next version from the commit history; both packages publish in order.
- CA-09: Release: tag 0.5.0 (or semantic-release's computed version) with GitHub Release + `npm view @brainervirus/workit` resolves; `@brainervirus/workit-cli` resolves.
- CA-10: README documents the code-review checks — the opencode GitHub workflows (opencode-review.yml pull_request + the /oc comment flows) with `opencode-go/deepseek-v4-flash`; branch protection includes the blocking ones; Bugbot listed as optional.
- CA-11: Zero `python3` invocations remain in packages/*/scripts and src (grep gate); the changelog apply runs via bun; README's Python prerequisite line is gone; `bun run check` green with the TS ports (changelog round-trip + vcs config + youtrack api tests pass).
- CA-12: Tests live under `test/<package>/**` mirroring packages/; CI has one check job per package (workit-core, workit-opencode, workit-cursor, workit-cli, shared) — the matrix shows per-package results.

## Decisions

- D-01: Scoped name `@brainervirus/workit` (user choice — plain workit taken; flowkit blocked).
- D-02: Entry points `wk-*` (user choice) — 12 skills + 12 commands renamed.
- D-03: Config dir + env vars unchanged (stability; the rename is the package/UX surface, not the user's installed state).
- D-04: Release bumps to 0.5.0 (v0.4.0 already shipped; 14 commits since → minor; the name change rides the same version — no separate version bump needed).
- D-05: GitHub repo renamed to `workit` (user choice) — remote URLs, README badges, and docs updated; git history preserved (rename via GitHub settings + remote URL update).
- D-06: Monorepo with per-platform publishes (user choice): `workit-core` shared, `workit-opencode` + `workit-cursor` thin platform packages (enables the cursor marketplace), `workit-cli` separate with `-cli` suffix.
- D-07: semantic-release with Conventional Commits for the whole release flow (user choice) — replaces the manual release.yml.
- D-08: Code review via the opencode GitHub integration (user's catch — https://opencode.ai/docs/github/): native, runs in our runners, uses our model provider, works as a required check; Bugbot (Cursor) remains an optional alternative documented in README.

## Future work

- A `wk doctor`/`wk status` alias command for parity with the old wf-status muscle memory.
- Config-dir migration tool if a rename is ever desired.
- Rebrand the GitHub repo name if the user ever wants full consistency.
- Cursor marketplace submission (the manifest ships in workit-cursor; publishing is manual).
- True auto-update for consumers (opencode lacks it for npm plugins; `latest` pin or a self-update command).
