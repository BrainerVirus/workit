# Workit next — plan (PR slices)

Spec: [`spec.md`](spec.md). Each slice = one PR, small enough for one context window, independently
tested and verified. Branch prefixes follow the repo (`feature/`, `bugfix/`, `chore/`, `docs/`) and use
conventional commits, because semantic-release reads them. Work happens in worktrees under
`../workit-wt/<slug>`: the main checkout is OpenCode's local pin, so root `bun run check` must not
run there.

Legend: ⟂ = parallel with siblings (branch from `main`) · ↳ = stacked on the previous slice.

## Phase 0 — Direction
- **S0** `docs/workit-next`: research, synthesis, spec, plan.

## Phase 1 — Stabilize (2.x patches, unblock daily use) ⟂
- **S1** `bugfix/store-lock-reclaim`: reclaim dead-pid/stale locks; short retry; contention returns retryable `busy`; `workit doctor --fix-lock`.
- **S2** ↳S1 `bugfix/bounded-recovery`: cap recovery copies (keep last 3); `workit gc` prunes `recovery/` and dedupes candidates; stop advertising `state.recover`.
- **S2b** ↳S2 `bugfix/engine-revision-retry`: bounded engine retry (re-read, re-check policy/requirements, re-apply) when the caller omits `expectedRevision`, so contention never surfaces `revision_conflict` to agents that didn't ask for CAS.
- **S3** ⟂ `chore/remove-dead-code`: delete unreachable modules (OpenCode docs-repo/rules/templates/youtrack tools, `docs-*`, `verify-*`, `present`, `ports/*`, `sync-runtime.ts`, `triage*`) and their tests; fix `knip.json` entries so knip guards it.
- **S4** ⟂ `bugfix/youtrack-timezone`: remove the greeting, mention and timezone config; fix the date off-by-one; keep the YouTrack adapter optional.
- **S5** ⟂ `bugfix/opencode-hot-path`: task index; cached compact context keyed by mtime; no candidate capture on context injection.
- **S6** ⟂ `chore/test-suite-cleanup`: delete tautological/byte-copy/prose/phase-9/parity tests; Node major-version check; split `test` vs `test:packaging`; CI runs every test dir.
- **S7** ⟂ `chore/tooling-refresh`: `.oxlintrc.json` (+ type-aware), single path list, lefthook + commitlint, actionlint/zizmor, dedupe CI builds, pin semantic-release, npm provenance, release gated on CI; dependency bumps (zod 4.6, MCP SDK 1.32, oxlint/oxfmt/knip, OpenCode SDK); delete probe workflows.

## Phase 2 — Deterministic CLI
- **S8** `feature/core-hooks`: extract the shared host-hook protocol (session context, shell branch policy, subagent start/stop, unfinished-task offer) into `core/hooks`; Codex/Cursor/Pi/OpenCode map onto it; add branch-policy denial to Cursor and Pi.
- **S9** ↳ `feature/cli-check`: `workit check -- <cmd>` records host-observed evidence; close gates accept only observed evidence or a waiver.
- **S10** ⟂S9 `feature/cli-pr-status`: `workit pr status --json`, `ci wait|rerun` (GitHub + GitLab).
- **S11** ↳S10 `feature/cli-git-verbs`: `workit git branch|commit|push`, `pr create|merge`, `verify-delivery` on every host (identity, conventions, base and tip checks).
- **S12** ↳S11 `feature/cli-stack`: `workit stack plan|sync|land` over plain base chains.
- **S13** ⟂ `feature/cli-ledger`: `workit ledger` (decisions, rulings, verdicts keyed to SHA with patch-id carry-over) + `handoff`.

## Phase 3 — Claude Code
- **S14** ↳S8 `feature/claude-code-adapter`: `packages/workit-claude-code` (plugin.json, repo marketplace, hooks → core/hooks, generated skills, agents, optional MCP), local `--plugin-dir` pin + marketplace latest, `claude plugin validate` + `claude plugin eval` smoke suite in CI.

## Phase 4 — Model simplification (3.0, breaking)
- **S15** `feature!: implicit-task-event-store`: implicit task per branch; append-only `events.jsonl` + snapshot; remove the `recovery/` dir; migration.
- **S16** ↳ `feature!: autonomy-grants`: remove the receipt approval chain + writer lease; per-workspace autonomy grants (push, pr, merge, release).
- **S17** ↳ `feature!: slim-policy`: 4-judgment assessment; flat tool schemas.
- **S18** ⟂ `chore!: retire-v1-cutover`: retire OpenCode V1 and cutover; move setup/doctor/upgrade into the CLI.

## Phase 5 — Skills and quality
- **S19** `feature!: skill-set-v3`: 10 skills; generated host copies + Cursor commands; trigger and token evals.
- **S20** ⟂ `feature/bdd-test-audit`: `bdd` skill; `workit test-audit` (static tautology heuristics + optional diff-scoped Stryker).
- **S21** ⟂ `feature/fanout-verify`: `fanout` skill + brief template + file-scope manifest; `verify-<app>` skill generator; autonomy contract in the bootstrap.

## Phase 6 — Docs
- **S22** `docs/rewrite`: README, AGENTS.md (<8 KB, with commands), CONTRIBUTING, issue/PR templates; archive superseded `docs/*` to `docs/archive/`; remove `.superpowers/`, `.workit-evaluation/`, `docs/manifest.json`.
- **S23** (deferred) Effect 4 in the CLI I/O layer, once Effect 4 is stable.

## Verification per slice
Focused tests for the changed behavior (Given/When/Then names), `bun run lint`, `format:check`,
`typecheck`, and knip. Root `bun test` runs in the worktree under Node 24. An independent review
subagent checks each PR before it is marked ready. CI must be green. Merge only on explicit user OK.
