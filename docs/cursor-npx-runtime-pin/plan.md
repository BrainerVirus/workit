# Cursor npm Runtime Pin Bugfix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/cursor-npx-runtime-pin/spec.md`
**Branch:** `bugfix/cursor-npx-runtime-pin`

**Goal:** Replace the cache-unsafe Cursor `@latest` runtime with the reviewed public `0.8.0` package, repair the real local install, and gate Marketplace submission on a released patch.

**Architecture:** Keep the existing npm executables and Cursor plugin structure. Change only the package selector from the mutable dist-tag to exact `0.8.0`, enforce that contract in doctor/tests/docs, then reinstall and verify the local plugin before release and submission.

**Tech Stack:** TypeScript, Cursor plugin JSON, npm/npx 10, Bun tests, Node 22, semantic-release.

## Global Constraints

- Exact package spec: `@brainervirus/workit-cursor@0.8.0`.
- Keep executables `workit-cursor-mcp` and `workit-cursor-session-start` unchanged.
- Do not delete user npm caches as the product fix.
- Do not return local installs to direct `node dist/...` execution.
- Preserve unrelated Cursor settings and MCP servers.
- Do not submit the Marketplace application before the patch is public and live smoke tests pass.
- Use RED/GREEN TDD and the smallest source diff.
- Commits, PR creation, and Marketplace submission require their normal explicit confirmations.

---

### Task 1: Pin and Enforce the Cursor Runtime

**Files:**
- Modify: `packages/workit-cursor/mcp.json`
- Modify: `packages/workit-cursor/hooks/hooks-cursor.json`
- Modify: `packages/workit-core/src/core/registration.ts:181-215`
- Modify: `packages/workit-core/src/core/doctor.ts:420-428`
- Modify: `test/artifacts/manifests.test.ts`
- Modify: `test/artifacts/registration.test.ts`
- Modify: `test/workit-core/doctor.test.ts`
- Modify: `test/workit-core/cursor-install-mcp.test.ts`
- Modify: `test/workit-core/install-scripts.test.ts`
- Modify: `test/workit-cli/packed-cli.test.ts`
- Modify: `test/workit-cursor/mcp-process.test.ts`
- Modify: `test/workit-cursor/mcp-regressions.test.ts`
- Modify: `test/shared/helpers/doctor-fixture.ts`
- Modify: `test/artifacts/phase-0-candidate.test.ts`

**Interfaces:**
- Produces MCP args `[-y, --package=@brainervirus/workit-cursor@0.8.0, workit-cursor-mcp, ${workspaceFolder}]`.
- Produces hook command `npx -y --package=@brainervirus/workit-cursor@0.8.0 workit-cursor-session-start`.
- Doctor accepts only the exact package spec and existing executable names.

- [ ] **Step 1: Change tests to require the exact pin**

Replace active `@latest` expectations with `@0.8.0`. Add doctor negative cases for `@latest`, `@0.8.0-alpha`, `@0.8.00`, and executable suffixes. Keep tests proving unrelated settings survive registration merges.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/registration.test.ts test/workit-core/doctor.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-cursor/mcp-process.test.ts`

Expected: FAIL because source configuration still uses `@latest`.

- [ ] **Step 3: Replace the active package selector**

Change only `--package=@brainervirus/workit-cursor@latest` to `--package=@brainervirus/workit-cursor@0.8.0` in static manifests and registration helpers. Update doctor exact-string validation to the same value; do not add range parsing or a version abstraction.

- [ ] **Step 4: Run all affected tests and verify GREEN**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/registration.test.ts test/workit-core/doctor.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-core/install-scripts.test.ts test/workit-cli/packed-cli.test.ts test/workit-cursor test/artifacts/phase-0-candidate.test.ts`

Expected: PASS with no active test fixture still selecting `@latest`.

**Criteria:** CA-01 through CA-05 pass.

---

### Task 2: Document and Repair the Local Installation

**Files:**
- Modify: `README.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Runtime update: `~/.cursor/plugins/local/workit/mcp.json`
- Runtime update: `~/.cursor/plugins/local/workit/hooks/hooks-cursor.json`
- Runtime update: `~/.cursor/mcp.json`

**Interfaces:**
- Consumes: exact runtime configuration from Task 1.
- Produces: user documentation and real local registration using `@0.8.0` while preserving non-Workit settings.

- [ ] **Step 1: Update active documentation**

Replace `@latest` commands in root/Cursor README with exact `@0.8.0`. Document that Marketplace runtime pins are deliberate reviewed updates, not mutable dist-tags. Add AGENTS parity/release policy and a concise Unreleased fix entry without claiming release or Marketplace acceptance.

- [ ] **Step 2: Verify no active runtime documentation uses `@latest`**

Run: `rg --glob '!docs/**' --glob '!node_modules/**' '@brainervirus/workit-cursor@latest' README.md AGENTS.md CHANGELOG.md packages test`

Expected: no matches.

- [ ] **Step 3: Rebuild and reinstall the local Cursor plugin**

Run: `bun run build` and then `bash packages/workit-core/scripts/install-cursor-plugin.sh`.

Expected: install succeeds, `~/.cursor/settings.json` still enables `workit`, unrelated MCP servers remain, and all three installed runtime configurations use exact `@0.8.0`.

- [ ] **Step 4: Run live exact-version smoke tests**

Run `npm exec --yes --package=@brainervirus/workit-cursor@0.8.0 -- workit-cursor-session-start`, then run the MCP executable with an MCP initialize/tools-list probe. Run `bun packages/workit-core/scripts/doctor-check.ts cursor`.

Expected: both executables start, MCP protocol output is valid, and doctor exits 0 without clearing `_npx` caches.

**Criteria:** CA-06, CA-07, and CA-09 pass.

---

### Task 3: Verify, Release, and Resume Marketplace Submission

**Files:**
- Verify: `docs/cursor-npx-runtime-pin/spec.md`
- Verify: `docs/cursor-npx-runtime-pin/plan.md`
- Verify: repository and public npm package
- External: Cursor publisher application at `https://cursor.com/marketplace/publish`

**Interfaces:**
- Consumes: Tasks 1-2 and the normal semantic-release workflow.
- Produces: public patch runtime and a Marketplace application submitted only after final verification.

- [ ] **Step 1: Run full repository verification**

Run: `bun run check && bun run verify:release-candidate && bun run validate:cursor-marketplace`.

Expected: all commands exit 0.

- [ ] **Step 2: Validate workflow documents**

Call `workit_docs_validate` with `docs/cursor-npx-runtime-pin/spec.md` and `docs/cursor-npx-runtime-pin/plan.md`.

Expected: `ok: true`, branch `bugfix/cursor-npx-runtime-pin`, and three ordered tasks.

- [ ] **Step 3: Commit and create the bugfix PR through Workit**

Use `wk-commit` and `wk-pr` with their native previews and confirmations. Do not bypass hooks or publish directly from the feature branch.

- [ ] **Step 4: Verify the released patch**

After merge and semantic-release success, query npm for the new `latest` version and its bins, then run both executables by that exact released version. Reinstall the local plugin if the committed pin changed during review.

- [ ] **Step 5: Resume the prepared Marketplace application**

Reopen the authenticated publisher form, recheck repository/logo/description fields, and use native confirmation before clicking `Submit Application`. Report submission status without claiming Cursor acceptance.

**Criteria:** CA-08 and CA-10 pass; the application is submitted only after public-runtime evidence.

| Status | Task |
| --- | --- |
| pending | 1: Pin and enforce the Cursor runtime |
| pending | 2: Document and repair the local installation |
| pending | 3: Verify, release, and resume Marketplace submission |
