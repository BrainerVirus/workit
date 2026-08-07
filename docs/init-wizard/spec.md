# Spec: flowkit init wizard — TUI multiplataforma

**Branch:** `feature/init-wizard`

## Context

The toolkit installs via `npm i flowkit` and configures through the `wf-init` skill (agent-driven, per-tool config in README). There is no CLI entry point, and the README's bash install path is Linux-only. Third-party users want a first-run experience like codex/claude-code: run one command, pick the platform, and get everything configured. This spec adds `npx flowkit init` — an interactive TUI wizard (React/Ink) that drives the existing `initApply` core logic.

## Goals

- G1: `bin` entry `flowkit` → `npx flowkit init` opens a TUI wizard (Ink/React, multiplatform: win/mac/linux).
- G2: Wizard steps: ① platform multiselect (OpenCode / Cursor), ② global config (locale, timezone, branch policy), ③ YouTrack scaffold (baseUrl, token placeholder + URL), ④ VCS scaffold (GitHub/GitLab), ⑤ project setup (gitignore + hygiene), ⑥ summary with paths + token URLs.
- G3: Wizard reuses `initApply` / `readConfig` / `writeConfig` from `src/core/` — no duplicated logic.
- G4: README install section replaced: `npm i flowkit` + `npx flowkit init` as the primary path (bash path removed), per-tool subsections kept for manual config.
- G5: Works from any directory; writes to the same `configDir()` and project `.gitignore`/hygiene files as `wf-init`.

## Non-goals

- No token *capture* in the wizard (tokens stay file-based, URLs are printed).
- No migration of existing configs (wizard edits existing config.json like wf-init does).
- No changes to the agent-side skills (wf-init stays the agent path).
- No CI/publish changes beyond what packaging already provides (the bin ships in the `files` whitelist).

## Architecture

```mermaid
flowchart TD
  %% Spec 10: flowkit init wizard — TUI multiplataforma
  npx["npx flowkit init"]
  wizard["Wizard TUI (Ink)"]
  platform["Plataforma: OpenCode/Cursor"]
  config["Config global"]
  youtrack["YouTrack scaffold"]
  vcs["VCS scaffold"]
  project["Proyecto: gitignore/hygiene"]
  apply["initApply (lógica existente)"]
  summary["Resumen + URLs de token"]
  npx -->|npx flowkit init| wizard
  wizard -->|multiselect| platform
  platform -->|locale/timezone/policy| config
  config -->|baseUrl + token URL| youtrack
  youtrack -->|provider (gh/gl)| vcs
  vcs -->|gitignore + hygiene| project
  project -->|apply actions via initApply| apply
  apply -->|print paths + token URLs| summary
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| `flowkit` bin | `"bin": { "flowkit": "./src/cli/index.ts" }` — bun-executable TS entry |
| `src/cli/` | New directory: `index.ts` (main), `steps.ts` (wizard steps), uses `@inkjs/ui`/`ink` + `@clack/prompts`-style prompts (ink components) |
| `initApply` | `src/core/init.ts` — actions `config`, `youtrack_scaffold`, `vcs_scaffold`, `gitignore`, `hygiene` (existing) |
| `configDir()` | `~/.config/workflow-toolkit/` (XDG) — same as wf-init |
| Run directory | Project root where `gitignore`/`hygiene` apply (the cwd of `flowkit init`) |

## Acceptance criteria

- CA-01: `npx flowkit init` (bin) renders an interactive wizard; each step can be completed with keyboard only; works on win/mac/linux (no bash dependency — `initApply` core is invoked directly, not via shell).
- CA-02: Selecting platforms writes nothing beyond config; at least one platform choice required to finish.
- CA-03: Config step validates locale (BCP-47), timezone, branch policy preset exactly like `wf-init` skill rules; `config.json` written via `writeConfig`.
- CA-04: YouTrack step writes `youtrack.json` scaffold (baseUrl + token placeholder) and prints the token-create URL + config path.
- CA-05: VCS step writes `vcs.json` scaffold for the chosen provider (gitlab/github) with token placeholder.
- CA-06: Project step runs `gitignore` and `hygiene` actions in the cwd; prints created files; never overwrites existing.
- CA-07: README install section: `npm i flowkit` + `npx flowkit init` primary, bash section removed, per-tool manual subsections retained.
- CA-08: `bun run check` green; new tests cover the step logic (validate + apply) without TTY; docs validate ok.

## Decisions

- D-01: Ink/React TUI (user choice) — the codex/claude-code style experience; `ink` + `@inkjs/ui` components.
- D-02: Reuse `initApply`/`writeConfig` core — the wizard is a UI over existing actions, not a rewrite.
- D-03: Tokens never typed into the wizard — URL/placeholder pattern, same as wf-init.
- D-04: `npx flowkit init` replaces the README bash install path (user choice).
- D-05: Wizard runs in cwd for project steps; global steps always hit `configDir()`.

## Future work

- `flowkit status` / `flowkit doctor` CLI siblings.
- Automated marketplace submission from the CLI.
- Homebrew install once adoption warrants.
