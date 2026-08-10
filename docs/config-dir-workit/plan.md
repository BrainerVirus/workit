# Config Dir Workit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/config-dir-workit/spec.md`
**Branch:** `feature/config-dir-workit`

**Goal:** `configDir()` defaults to `~/.config/workit/` with a one-time copy migration from the legacy `~/.config/workflow-toolkit/` dir.

## Global Constraints

- The env chain (WORKFLOW_TOOLKIT_CONFIG → WORKFLOW_TOOLKIT_CONFIG_DIR → XDG_CONFIG_HOME → default) is UNCHANGED — only the final default segment changes to `workit`.
- Migration is copy-not-move, lazy (first configDir() call), idempotent, never deletes legacy.
- Scripts (bash) must resolve the same way — a shared helper or mirrored logic in the .sh files.
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: configDir() default + migration core (TS)

- [ ] **Step 1:** `packages/workit-core/src/core/config.ts`: `configDir()` default segment becomes `workit`. Add `ensureConfigDir()` (or fold into configDir with a side-effect): when the env overrides are absent, the new dir doesn't exist, and the legacy `~/.config/workflow-toolkit/` does → copy its files (config.json, youtrack.json, vcs.json, workspaces.json, docs-repo.json, *.token, templates/ recursive) into the new dir, skipping existing targets (never overwrite, never delete). Called lazily from configDir().
- [ ] **Step 2:** Update the derived paths to use the resolved config dir: `packages/workit-core/src/tools/youtrack.ts:27`, `src/core/vcs-config.ts:72,173,179`, `src/core/docs-repo.ts:8`, `src/core/youtrack.ts:15` (the configPath default) — all currently hardcode `"workflow-toolkit"`; they should resolve from configDir() (import it, or a `configFilePath(rel)` helper).
- [ ] **Step 3:** Tests `test/workit-core/config-dir.test.ts` (or extend config.test.ts): CA-01 (no dirs → workit/), CA-02 (legacy present → copied once, second call no re-copy), CA-03 (new dir present → no migration), CA-04 (env override → no migration), CA-05 (derived paths follow).

**Criteria:** CA-01..CA-05.

| Status | Task |
| --- | --- |
| pending | 1: configDir() default + migration core (TS) |

### Task 2: Scripts parity + share paths

- [ ] **Step 1:** The bash scripts that resolve the config dir: `packages/workit-core/scripts/init/apply.sh`, `status.sh`, `vcs/config.sh`, `youtrack/config.sh`, `token-create-url*.sh`, `sync-runtime.sh` (the CONFIG_RULES_DIR + CONFIG_DIR lines) — update their default from `~/.config/workflow-toolkit` to `~/.config/workit` AND add the same lazy migration check (a small shared snippet: `[ -d "$LEGACY" ] && [ ! -d "$NEW" ] && cp -r "$LEGACY/." "$NEW/"`). Reuse the chain pattern already in apply.sh:8.
- [ ] **Step 2:** Verify parity: a TS call and the matching bash script resolve the SAME dir after migration (test: temp HOME with legacy dir → TS configDir migrates → bash config.sh load finds the files).

**Criteria:** CA-05, CA-06 (scripts agree with TS).

| Status | Task |
| --- | --- |
| pending | 1: configDir() default + migration core (TS) |
| pending | 2: Scripts parity + share paths |

### Task 3: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (migration idempotency + safety, env-chain precedence, script parity, no stale workflow-toolkit defaults left in src or scripts).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/config-dir-workit`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: configDir() default + migration core (TS) |
| pending | 2: Scripts parity + share paths |
| pending | 3: Final gate — review + PR |
