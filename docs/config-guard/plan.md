# Config Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/config-guard/spec.md`
**Branch:** `feature/config-guard`

**Goal:** Structured config-gap errors in tools + a per-turn reminder rail that asks the user whether to configure now (only missing / full wizard / skip).

## Global Constraints

- Reuse `initStatus` item ids and `configDir()`; no new config schema.
- New reminder text lives in `src/core/reminder.ts` alongside `SDD_REMINDER_TEXT`; hook logic in `src/plugin.ts` inside `chat.messages.transform` (same try/catch, idempotent, fail-closed).
- Tools: only the error wrapping changes — no behavior change when config exists.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: configGuard core + structured tool errors

- [ ] **Step 1:** New `src/core/config-guard.ts`: `describeConfigGaps(): { missing: string[]; ok: boolean }` — reads `initStatus()` items and returns ids with `ok: false` (tolerates missing config dir / script errors → all items missing, no throw). `configGuardError(missing: string[]): string` → `workflow config missing: <list>. Run \`npx flowkit init\` or \`/wf-init\` to configure.` Also export a stable marker constant (e.g. `CONFIG_GAP_MARKER = "workflow config missing"`).
- [ ] **Step 2:** In `src/tools/youtrack.ts`, wrap `readCredentials()` failures: catch the read error, call `describeConfigGaps()` (scoped to youtrack ids), and return the structured `configGuardError` instead of the raw ENOENT message. Apply to the tools that call `credentials()` (context, draft, post, log_time). Keep behavior identical when config exists.
- [ ] **Step 3:** Tests: `test/config-guard.test.ts` — (a) empty config dir → all 5 item ids missing, ok:false, no throw; (b) partial (only youtrack.json present, no token) → `youtrack_token` missing; (c) `configGuardError` output contains the marker + list + fix path; (d) tool-level: a youtrack tool with a broken/missing config returns the structured error, not `ENOENT` (use a temp `XDG_CONFIG_HOME`).

**Criteria:** CA-01, CA-02.

| Status | Task |
| --- | --- |
| pending | 1: configGuard core + structured tool errors |

### Task 2: Per-turn config-guard reminder rail

- [ ] **Step 1:** Add `CONFIG_GUARD_TEXT` to `src/core/reminder.ts` (style of `SDD_REMINDER_TEXT`): instructs that when a tool failed with a config-gap error, ask with native `question` — exactly three options: configure only what's missing (guided via `/wf-init` for those actions), run the full wizard (`npx flowkit init`), or skip (report the error naming the missing items). Add `shouldInjectConfigGuard(text)` idempotency helper.
- [ ] **Step 2:** In `src/core/detector.ts` add `detectConfigGapError(text: string): boolean` — true when the text contains the `CONFIG_GAP_MARKER`.
- [ ] **Step 3:** In `src/plugin.ts` `chat.messages.transform`, after the SDD-reminder injection: when `detectConfigGapError(assistantText)` is true and the current turn lacks the marker, unshift `CONFIG_GUARD_TEXT` via the `makePart` pattern with a distinct tag (e.g. `"cg"`).
- [ ] **Step 4:** Tests in `test/plugin-reminder.test.ts` (or config-guard test file): marker present in assistant text → injected once; absent → not injected; idempotent; no crash on missing docs/ (fail-closed).

**Criteria:** CA-03, CA-04.

| Status | Task |
| --- | --- |
| pending | 1: configGuard core + structured tool errors |
| pending | 2: Per-turn config-guard reminder rail |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (gap detection correctness, tool error wrapping, reminder wording with exactly 3 options, idempotency, fail-closed).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/config-guard`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: configGuard core + structured tool errors |
| pending | 2: Per-turn config-guard reminder rail |
| pending | 3: Final gate — review + PR |
