# Spec: Rebrand workit — @brainervirus/workit, wk-* entry points

**Branch:** `feature/rebrand-workit`

## Context

The npm name `flowkit` is blocked by npm's anti-squatting rule (too similar to the existing `flow-kit`); the user prefers the `workit` wordplay (work + kit) and wants the entry points renamed from `wf-*` to `wk-*`. The plain `workit` name is taken (v2.1.0), so the package ships as `@brainervirus/workit` (verified free). This spec renames EVERYTHING: package identity, bin, skills, commands, identifiers, texts, cursor plugin, docs, README — and keeps the toolkit fully functional, then releases v0.4.0 under the new name.

## Goals

- G1: `package.json`: `name: "@brainervirus/workit"`, `bin: { "workit": "./src/cli/index.tsx" }` (scoped package, public access — `publishConfig.access: "public"` already present), description/keywords updated.
- G2: All 12 skills + 12 commands renamed `wf-*` → `wk-*` (file names, YAML frontmatter names, references in src/plugin.ts descriptions, cursor plugin registration).
- G3: `src/` identifiers/texts: `workflow-toolkit` → `workit`, `wf-` → `wk-` in user-facing strings, tool descriptions, error messages, and internal names where they surface in output; functional internal identifiers (functions/types) stay unless they leak into UX.
- G4: Cursor plugin: plugin.json, mcp.json, rules, hooks paths and names updated; run-server.sh fallbacks (`~/.local/share/workflow-toolkit` → `~/.local/share/workit`).
- G5: `docs/` + README + CONTRIBUTING + templates: all `workflow-toolkit`/`wf-` references updated; the wf-* skill references inside specs are updated where they describe the entry points.
- G5b: Code-review check via **opencode GitHub integration** (verified at https://opencode.ai/docs/github/): `opencode github install` sets up the GitHub App + workflow; the `pull_request` event (opened/synchronize/reopened) runs `anomalyco/opencode/github@latest` on the runner and reviews each PR automatically (default prompt reviews the PR; custom prompt enforces the toolkit's standards). Registered as a required check in branch protection. Cursor Bugbot stays documented as an optional alternative.
- G6: The user's live config (`~/.config/workflow-toolkit/`) is NOT renamed (config dir stability — optional alias note in README).
- G7: Monorepo restructure (bun workspaces): `packages/workit` (core: plugin opencode+cursor, skills, commands, core TS) + `packages/workit-cli` (the Ink TUI — published separately as `@brainervirus/workit-cli`, the user's choice of `-cli` suffix); root package.json becomes the workspace root.
- G8: GitHub repo renamed `workflow-toolkit` → `workit` (user asked — repo, releases, and docs references all updated; remote URLs in README/package.json updated).
- G9: Release automation with semantic-release (Conventional Commits): automated version bump, changelog, tags, and ordered publish of both packages; replaces the manual release.yml flow.
- G10: v0.4.0 released under the new names: tag, GitHub Release, `npm publish` of `@brainervirus/workit` + `@brainervirus/workit-cli` (secret configured).

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
  publish["Release v0.4.0"]
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
| Package name | `@brainervirus/workit` (scoped, public access) |
| Bin | `workit` (the CLI entry; the `wk` shorthand is for the agent-facing commands/skills) |
| Entry points | `wk-*` (12 skills + 12 commands), e.g. `wk-init`, `wk-pr`, `wk-implement` |
| Config dir | `~/.config/workflow-toolkit/` UNCHANGED (stability; README documents the alias) |
| Env vars | `WORKFLOW_TOOLKIT_CONFIG*` UNCHANGED (documented) |
| Release | v0.4.0 → `@brainervirus/workit@0.4.0` |

## Acceptance criteria

- CA-01: `npm pack --dry-run` shows `@brainervirus/workit` with `bin.workit`; tarball sane (<2MB, no node_modules).
- CA-02: Zero remaining `wf-` entry-point references in skills/, commands/, and src/plugin.ts descriptions (grep gate — the existing "no docs/superpowers paths" style test extended or a new grep gate).
- CA-03: `wk-*` skills/commands load: plugin registration test asserts the 12 `wk-` names; cursor plugin.json/mcp.json reference the new names.
- CA-04: `bun run check` green; cursor MCP smoke test still answers tools/list; the user's config dir/env still resolve (no rename touched them).
- CA-05: README/CONTRIBUTING/templates have zero stale `workflow-toolkit`/`wf-` references (grep gate); install section shows `npm i @brainervirus/workit` + `npx workit init`.
- CA-06: Monorepo: `bun install` at the root resolves both packages; `packages/workit-cli` has its own package.json (`@brainervirus/workit-cli`, bin `workit`) and the core is `@brainervirus/workit`; root scripts delegate to both.
- CA-07: GitHub repo renamed to `workit`; `git remote get-url origin` resolves; README badges/URLs updated; no stale `workflow-toolkit` repo-name references in README/CONTRIBUTING (grep gate).
- CA-08: semantic-release config present (release config with Conventional Commits); dry-run produces the expected next version from the commit history; both packages publish in order.
- CA-09: Release: tag v0.4.0 (or semantic-release's computed version) with GitHub Release + `npm view @brainervirus/workit` resolves; `@brainervirus/workit-cli` resolves.
- CA-10: README documents the code-review check — the opencode GitHub integration workflow (`.github/workflows/opencode-review.yml`, pull_request event) with the review prompt; branch protection includes it as a required check; Bugbot listed as an optional alternative.

## Decisions

- D-01: Scoped name `@brainervirus/workit` (user choice — plain workit taken; flowkit blocked).
- D-02: Entry points `wk-*` (user choice) — 12 skills + 12 commands renamed.
- D-03: Config dir + env vars unchanged (stability; the rename is the package/UX surface, not the user's installed state).
- D-04: Release bumps to 0.4.0 as planned (the name change rides the same version; no separate version bump needed).
- D-05: GitHub repo renamed to `workit` (user choice) — remote URLs, README badges, and docs updated; git history preserved (rename via GitHub settings + remote URL update).
- D-06: Monorepo via bun workspaces (`packages/workit` + `packages/workit-cli`) — the CLI ships separately with the `-cli` suffix (user choice).
- D-07: semantic-release with Conventional Commits for the whole release flow (user choice) — replaces the manual release.yml.
- D-08: Code review via the opencode GitHub integration (user's catch — https://opencode.ai/docs/github/): native, runs in our runners, uses our model provider, works as a required check; Bugbot (Cursor) remains an optional alternative documented in README.

## Future work

- A `wk doctor`/`wk status` alias command for parity with the old wf-status muscle memory.
- Config-dir migration tool if a rename is ever desired.
- Rebrand the GitHub repo name if the user ever wants full consistency.
