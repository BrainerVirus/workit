# Open-source Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/open-source/spec.md`
**Branch:** `feature/open-source`

**Goal:** Make the toolkit distributable as the public `flowkit` npm package with CI matrix, publish-on-tag, and open-source scaffolding.

## Global Constraints

- Packaging-only: no API or behavior changes to `src/` in this spec.
- Keep local dev working via `file:` install (the repo's own opencode plugin config must not break).
- `bun run check` must stay green; CI gate is the same command.
- Follow repo conventions: TypeScript/bun, no code comments unless asked, conventional commits.
- The repo itself is the consumer: after packaging, `workflow_docs_validate` hygiene findings for LICENSE/CONTRIBUTING/README must turn green.

---

### Task 1: Public package metadata + LICENSE/CONTRIBUTING/README

- [ ] **Step 1:** Edit `package.json`: `"private": false`, `"name": "flowkit"`, `"description"` (one-liner: workflow rails for agentic coding), `"license": "MIT"`, `"repository"` (BrainerVirus/workflow-toolkit), `"files"` whitelist (dist/ or src/ + skills/ + commands/ + cursor/ + vendor/superpowers/skills/ + templates/ + README.md + LICENSE). Verify nothing runtime-required is excluded; run the existing test suite against a `file:`-installed consumer if feasible, else confirm `bun run check` green.
- [ ] **Step 2:** Add `LICENSE` (MIT, `<YEAR>` current, Cristhofer Pincetti) and `CONTRIBUTING.md` (how to install from source, run check, branch policy, PR flow) — can be generated via `ensureHygieneFiles` with `includeOpenSource: true` then completed by hand; reference both from README.
- [ ] **Step 3:** Extend `README.md`: install section (`npm i flowkit` for consumers, `file:` for local dev), usage for OpenCode + Cursor, badges placeholders (npm version `[npm-badge]`, CI, license), kudos section (vendored `vendor/superpowers` by Adam Wiggins; ponytail mode credit).

**Criteria:** CA-01/CA-03/CA-05-07 (public pkg, LICENSE/CONTRIBUTING, README with badges+kudos, validate green, hygiene findings gone).

| Status | Task |
| --- | --- |
| pending | 1: Public package metadata + LICENSE/CONTRIBUTING/README |

### Task 2: CI matrix + publish-on-tag workflow

- [ ] **Step 1:** Update `.github/workflows/ci.yml` (or equivalent): matrix `[ubuntu-latest, macos-latest, windows-latest]` running `bun run check` (bun/setup-bun action, `bun i` + `bun run check`); keep existing jobs behavior.
- [ ] **Step 2:** Add `.github/workflows/publish.yml`: on `push` of `v*` tags — checkout, setup bun, `bun i`, `bun run check`, then `npm publish` with `NODE_AUTH_TOKEN` from secrets (`npmjs` secret); `permissions: contents: read` + `packages: write` (or id-token for provenance if chosen).

**Criteria:** CA-02 (matrix runs check on 3 OS; publish gated on `v*` tags, never on push/PR).

| Status | Task |
| --- | --- |
| pending | 1: Public package metadata + LICENSE/CONTRIBUTING/README |
| pending | 2: CI matrix + publish-on-tag workflow |

### Task 3: GitHub templates + cursor marketplace manifest

- [ ] **Step 1:** Add `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md` (with the toolkit's context: which platform — OpenCode/Cursor, which tool, expected vs actual) and `.github/PULL_REQUEST_TEMPLATE.md` (what it does, quality gates: `bun run check`, docs validate).
- [ ] **Step 2:** Add `cursor/marketplace.json` manifest (name: flowkit, description, publisher, version from package.json, assets list) + extend README with a "Cursor marketplace" subsection documenting how a consumer would add it (manual submission note).
- [ ] **Step 3:** Run `bun run check` (typecheck must include marketplace.json if wired, else manual JSON validity check via `bun -e JSON.parse`), run `workflow_docs_validate` equivalent, commit.

**Criteria:** CA-04/CA-06 (templates exist; manifest valid JSON with correct metadata).

| Status | Task |
| --- | --- |
| pending | 1: Public package metadata + LICENSE/CONTRIBUTING/README |
| pending | 2: CI matrix + publish-on-tag workflow |
| pending | 3: GitHub templates + cursor marketplace manifest |

### Task 4: Final gate — review + PR

- [ ] **Step 1:** Subagent review of the branch diff (packaging correctness: files whitelist completeness, CI matrix, publish gating, template quality, manifest validity).
- [ ] **Step 2:** Apply review fixes if any; `bun run check`; commit.
- [ ] **Step 3:** Push `feature/open-source`, create PR, wait for CI (3 OS), merge, delete branch.

**Criteria:** Review findings addressed; CI pass on all 3 OS; PR merged to main.

| Status | Task |
| --- | --- |
| pending | 1: Public package metadata + LICENSE/CONTRIBUTING/README |
| pending | 2: CI matrix + publish-on-tag workflow |
| pending | 3: GitHub templates + cursor marketplace manifest |
| pending | 4: Final gate — review + PR |
