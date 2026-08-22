# Spec: Open-source packaging — flowkit

**Branch:** `feature/open-source`

## Context

The toolkit has shipped 11 PRs of workflow enforcement, but it is closed-source: no public LICENSE, no npm distribution, no open-source plumbing. The repo stays installable as a local `file:` path, but nothing prevents others from using it — and nothing tells them how. This spec makes the project distributable and consumable by third parties: a public npm package (`flowkit`), a documented install flow for OpenCode and Cursor, a CI matrix that verifies on three OSes and publishes on tag, plus open-source scaffolding (LICENSE, CONTRIBUTING, GitHub templates, badges).

## Goals

- G1: Publish the plugin as a public npm package named `flowkit` (verified free on npm; `wtk` is taken by an unrelated SPA framework).
- G2: Hybrid install: `npm i flowkit` works for consumers; local `file:` install keeps working for development.
- G3: CI matrix (ubuntu/macos/windows) runs `bun run check`; a tagged release triggers `npm publish`.
- G4: Open-source scaffolding: LICENSE (MIT, holder = Cristhofer Pincetti), CONTRIBUTING.md, GitHub issue/PR/bug templates, README badges.
- G5: Cursor marketplace readiness — a manifest and docs describing how to consume the published package (marketplace publishing itself is manual).
- G6: Kudos: the vendored `vendor/superpowers` attribution and ponytail credit preserved/attributed in the package README.

## Non-goals

- No actual `npm publish` execution in this spec (requires auth; CI does it on tag).
- No marketplace *publication* (cursor marketplace submission is manual, out of repo scope).
- No license changes for the vendored superpowers content (kept as-is with attribution).
- No API changes; this is packaging + distribution only.

## Architecture

```mermaid
flowchart TD
  %% Spec 9: open-source packaging — flujo de distribución
  pkg["Package público (flowkit)"]
  publish["CI/CD publish npm"]
  install["Instalación híbrida npm"]
  opencode["OpenCode plugin"]
  cursor["Cursor plugin"]
  dev["Desarrollo local (file:)"]
  ci["Matriz CI 3 OS"]
  pkg -->|npm publish flowkit| publish
  publish -->|npm i flowkit| install
  install -->|plugin config| opencode
  install -->|plugin config| cursor
  opencode -->|local dev (file:)| dev
  cursor -->|local dev (file:)| dev
  ci -->|ubuntu/macos/windows verify| publish
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| `flowkit` | Public npm package name (repo `workflow-toolkit`) |
| `package.json` | Must be public (`"private": false` — flips the hygiene open-source heuristic) |
| `files` | npm whitelist: `src/`, `skills/`, `commands/`, `cursor/`, `vendor/superpowers/skills/`, `scripts/`, `templates/`, `README.md`, `LICENSE` |
| Tag trigger | CI publish job runs on `v*` tags only |
| Marketplace manifest | `cursor/marketplace.json` — name, description, publisher, version |
| Kudos | README credits: vendored `vendor/superpowers` (Adam Wiggins), ponytail mode |

## Acceptance criteria

- CA-01: `package.json` is public (`private: false`), `name: "flowkit"`, `files` whitelist includes all runtime assets; `bun run check` still green locally and via `file:` install.
- CA-02: CI matrix runs `bun run check` on ubuntu-latest, macos-latest, windows-latest; publish job gated on `v*` tags and `npm publish` with the built artifact.
- CA-03: `LICENSE` (MIT, current year, Cristhofer Pincetti) and `CONTRIBUTING.md` exist and are referenced from README.
- CA-04: `.github/ISSUE_TEMPLATE/` (bug + feature) and `.github/PULL_REQUEST_TEMPLATE.md` exist.
- CA-05: README has badges (npm version, CI matrix, license) and a kudos section crediting superpowers + ponytail.
- CA-06: `cursor/marketplace.json` manifest exists with valid metadata (validate via `bun run check` if wired, else manual review).
- CA-07: `workit_docs_validate` on this spec/plan pair passes; hygiene findings for LICENSE/CONTRIBUTING/README turn green (no longer warnings) for this repo.

## Decisions

- D-01: `flowkit` over `wtk` — `wtk` taken on npm; user chose flowkit from verified-free candidates.
- D-02: npm publish deferred to CI-on-tag; spec never pushes real auth.
- D-03: Packaging-first — no code behavior changes in this spec; distribution only.
- D-04: Cursor marketplace = manifest + docs (manual submission later).

## Future work

- Automate cursor marketplace submission (API).
- `npm publish` dry-run in CI on every merge to catch packaging drift early.
- Homebrew/other installers if adoption warrants.
