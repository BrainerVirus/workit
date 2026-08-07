# Init Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/init-wizard/spec.md`
**Branch:** `feature/init-wizard`

**Goal:** Ship `npx flowkit init` — an interactive Ink/React TUI wizard over the existing `initApply` core, and make it the README's primary install path.

## Global Constraints

- Reuse `src/core/init.ts` (`initApply`, `initStatus`), `src/core/config.ts` (`readConfig`, `writeConfig`, `configDir`), `src/core/youtrack.ts`, and `src/core/gitignore.ts`/`hygiene.ts` — the wizard is a UI over existing actions, never duplicated logic.
- No token capture: the wizard only writes placeholders and prints token-create URLs (same as wf-init).
- Multiplatform: no shell-out to bash in the wizard's own flow (the core functions are invoked directly; `gitignore`/`hygiene` core functions take a root path).
- `bun run check` must stay green; CI matrix (3 OS) is the gate.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.

---

### Task 1: CLI entry + wizard skeleton

- [ ] **Step 1:** Add `"bin": { "flowkit": "./src/cli/index.ts" }` to `package.json` (keep `files` including `src/` — it already ships). Create `src/cli/index.ts`: parses `argv` (`init` subcommand; no args → help), and for `init` renders the wizard.
- [ ] **Step 2:** Add Ink deps to `dependencies`: `ink`, `react`, `@inkjs/ui` (verify versions compatible with each other and Node/bun; use `bun add`). Render a first TUI screen (title + step list) that exits cleanly.
- [ ] **Step 3:** Test: a non-TTY smoke test — `bun -e` importing the CLI module must not crash; CLI help path prints and exits 0.

**Criteria:** `flowkit` bin resolves (`bun run` / `node` smoke), wizard renders in TTY, help works, deps installed.

| Status | Task |
| --- | --- |
| pending | 1: CLI entry + wizard skeleton |

### Task 2: Wizard steps (platform, config, youtrack, vcs, project, summary)

- [ ] **Step 1:** `src/cli/steps.ts`: step ① platform — multiselect OpenCode/Cursor; step ② config — locale (validate BCP-47 `^[a-z]{2,3}(-[A-Z]{2})?$`), timezone, branch policy preset (gitflow/github-flow/trunk-based/custom; custom → allowed/protected inputs); step ③ YouTrack — baseUrl input + scaffold via core; step ④ VCS — provider gitlab/github + scaffold; step ⑤ project — `gitignore` + `hygiene` on cwd (prints created, never overwrites); step ⑥ summary — config path, youtrack path + token URL, vcs path, created project files.
- [ ] **Step 2:** Wire steps into `index.ts` sequentially; each step's apply calls the existing core functions with `confirmed: true` semantics (the user already confirmed by advancing the wizard).
- [ ] **Step 3:** Tests (no TTY): extract the step logic into testable functions (`collectConfig`, `validateLocale`, `runProjectSetup(root)`) and cover validation + apply behavior; wizard rendering itself is smoke-tested only.

**Criteria:** CA-02/03/04/05/06 — steps validate exactly like wf-init, write via core, print URLs, never overwrite.

| Status | Task |
| --- | --- |
| pending | 1: CLI entry + wizard skeleton |
| pending | 2: Wizard steps (platform, config, youtrack, vcs, project, summary) |

### Task 3: README install path + packaging verification

- [ ] **Step 1:** README Install section: `npm i flowkit` + `npx flowkit init` as primary (wizard description one-liner); remove the bash install section; keep per-tool manual subsections (OpenCode config + Cursor mcp.json) for those who skip the wizard.
- [ ] **Step 2:** Verify the bin ships: `npm pack --dry-run` includes `src/cli/`; `npx flowkit` (from a packed install or `bun link`) resolves.

**Criteria:** CA-01/CA-07 — README npx-primary, no bash, bin in tarball.

| Status | Task |
| --- | --- |
| pending | 1: CLI entry + wizard skeleton |
| pending | 2: Wizard steps (platform, config, youtrack, vcs, project, summary) |
| pending | 3: README install path + packaging verification |

### Task 4: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (wizard logic vs core reuse, validation parity with wf-init, packaging, README).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/init-wizard`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: CLI entry + wizard skeleton |
| pending | 2: Wizard steps (platform, config, youtrack, vcs, project, summary) |
| pending | 3: README install path + packaging verification |
| pending | 4: Final gate — review + PR |
