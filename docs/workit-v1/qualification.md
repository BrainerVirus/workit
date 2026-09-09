# Workit v1 release qualification

This document defines the commands and evidence format for stable Workit v1
release qualification. It does **not** contain live evaluation results; those
are recorded only after an explicitly authorized batch completes.

## Deterministic gate (every commit)

```bash
bun test test/acceptance/deterministic.test.ts
bun run check
bun run verify:release-candidate
```

`verify:release-candidate` packs all seven workspace packages locally, verifies
CA-31 toolchain evidence, CA-32 MCP draft-2020-12 schema parity, frozen
fixtures, and the adapter capability matrix. It never publishes or invokes live
model sessions.

## Live evaluation (authorized batch only)

Before any live batch, obtain authorization for:

- permitted models per coding host (`opencode`, `cursor`, `codex_cli`, `codex_desktop`, `pi`)
- `maxRuns >= 90`
- wall-time limit (including helpers and resume activity)
- usage/spending ceiling (`usd` or `tokens`)
- `externalWrites: false` unless a separate action authority covers mutations

Export the authorization JSON in `WORKIT_EVALUATION_AUTHORIZATION`, then inspect
the planned batch without running models:

```bash
# HARD STOP: do not run until authorization is granted
bun scripts/run-v1-evaluation.ts
```

Without authorization the script exits `2` with `needs_input`.

## Qualification matrix

| Layer | Count | Description |
| --- | --- | --- |
| Main runs | 60 | five coding hosts × six scenarios × with/without Workit |
| Safety repeats | 30 | Workit-only repeats of E-02, E-05, and E-06 (×2 per host) |
| CLI checks | separate | command-level acceptance without model sessions |

Fixture revision: `workit-v1-2026-09-09` (see `test/acceptance/scenarios.ts`).

## Evidence format

Raw run artifacts live under `.workit-evaluation/` (gitignored). Each run record
includes:

- host, model, Workit on/off, policy/config/fixture identity
- observable actions (scored separately from self-reported compliance)
- questions, artifacts, test rounds, review rounds, elapsed time, usage
- disposition: `passed`, `failed`, `discarded`, or `missing`

Preserve failed attempts and their dispositions. Rerun only affected scenarios
plus relevant regressions within the authorized budget.

Reviewed summaries and fixture definitions may be committed; raw transcripts stay
ignored until reviewed.

## Stable release gate

`stableReleaseGate` requires:

1. passing deterministic CA-31/CA-32 evidence on the locked candidate
2. no missing, discarded, or unresolved failed required live runs
3. complete 90-run qualification evidence
4. capability matrix with no unknown/untested cells counted as supported

Publication and installation promotion remain a separate explicit release action
after every gate passes.
