# Spec: Config guard on-demand

**Branch:** `feature/config-guard`

## Context

A user who skipped the `npx flowkit init` wizard (or never ran `/wf-init`) hits raw failures when a tool needs configuration: `readCredentials` throws `ENOENT: ... youtrack.json`, and the agent sees no path forward. There is no structured signal for "what is missing, how to fix it, and whether the user wants to configure now". This spec adds the on-demand config guard: tools return structured config-gap errors, a per-turn reminder instructs the agent to ask via native `question` (configure only what's missing / full wizard / skip), and skipping yields a clear final error naming the missing items.

## Goals

- G1: A `configGuard()` core helper (and `describeConfigGaps()`) reports exactly which config items are missing — mirroring `initStatus` items: `youtrack_json`, `youtrack_token`, `vcs_json`, `gitlab_token`, `github_token`.
- G2: YouTrack/VCS/init tools return structured errors on missing config: the message lists missing items and the fix path (wizard or `/wf-init`), instead of raw ENOENT.
- G3: A per-turn `CONFIG_GUARD_TEXT` reminder (mirroring `SDD_REMINDER_TEXT`) is injected when the previous assistant message shows a config-gap error: instructs asking with native `question` — three options: configure only the missing piece (guided), run the full wizard (`npx flowkit init`), or skip (report the error with what's missing).
- G4: When the user chooses "skip", the agent reports the final error naming the missing config items and how to configure them.
- G5: Idempotent, fail-closed (no config dir → helper returns all items missing without throwing; hook never crashes).

## Non-goals

- No new config storage or schema changes; reuse `initStatus`/`configDir`/`readConfig`.
- No change to the wizard (`npx flowkit init`) itself.
- No automatic configuration without user consent — the question is mandatory.
- No change to token capture rules (tokens stay file-based with URLs).

## Architecture

```mermaid
flowchart TD
  %% Spec: config guard on-demand
  tool["Tool necesita config (youtrack/vcs/config)"]
  guard["configGuard: describe gaps"]
  error["Error estructurado: qué falta + cómo"]
  reminder["CONFIG_GUARD_TEXT por turno"]
  ask["¿Configurar ahora?"]
  choice["Elección del usuario"]
  guided["Asistencia solo lo faltante"]
  wizard["npx flowkit init completo"]
  no["Error final: falta configurar X"]
  tool -->|readCredentials/initStatus falla| guard
  guard -->|gaps + fix (qué falta)| error
  error -->|tool devuelve error estructurado| reminder
  reminder -->|hook detecta error config en mensaje previo| ask
  ask -->|question nativa 3 opciones| choice
  choice -->|configurar solo lo faltante| guided
  choice -->|wizard completo| wizard
  choice -->|no configurar| no
```

## Data flow / contracts

| Term | Meaning |
| --- | --- |
| `describeConfigGaps()` | `{ missing: string[], ok: boolean }` — names like `youtrack_json` (item ids from `initStatus`) |
| `configGuardError(scope)` | Structured error string: `workflow config missing: <missing list>. Run \`npx flowkit init\` or \`/wf-init\` to configure.` |
| `CONFIG_GUARD_TEXT` | New reminder constant in `src/core/reminder.ts` |
| Detector | `detectConfigGapError(text)` — true when the assistant text contains the guard error marker (e.g. `workflow config missing`) |

## Acceptance criteria

- CA-01: `describeConfigGaps()` returns all expected item ids as missing when the config dir is empty; `ok: false`; does not throw.
- CA-02: YouTrack tools that read credentials (`context`, `verify_token`, `post`, `log_time`; `draft` is credential-free by design) return the structured config-gap error (not raw ENOENT) when `youtrack.json`/token are missing.
- CA-03: The per-turn hook injects `CONFIG_GUARD_TEXT` exactly once when the previous assistant message contains the config-gap marker; no injection otherwise; idempotent.
- CA-04: The reminder text asks for a native `question` with exactly three options: configure only what's missing (guided), full wizard (`npx flowkit init`), or skip (report the error).
- CA-05: `bun run check` green; new tests cover CA-01..CA-03; docs validate ok.

## Decisions

- D-01: Error + reminder (user choice) — structured errors in tools, plus a per-turn rail like `SDD_REMINDER_TEXT`.
- D-02: Three question options: only-missing / full wizard / skip (user choice).
- D-03: All config scopes covered (YouTrack + VCS + global) via `initStatus` item ids.
- D-04: Guided option delegates to the existing `/wf-init` skill flow for the missing action(s) — no new scaffold logic.

## Future work

- A dedicated `flowkit doctor` CLI that runs `describeConfigGaps` and prints a fix checklist.
- Automatic wizard launch when only the wizard itself was never run (first-run detection).
