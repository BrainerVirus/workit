# Reliability and Cursor Marketplace Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/reliability-marketplace-readiness/spec.md`
**Branch:** `feature/reliability-marketplace-readiness`

**Goal:** Ship a reliable, quiet Workit release, then prepare the public repository for Cursor Marketplace submission after the corrected npm runtime is available.

**Architecture:** Release 1 fixes state identity, host-specific diagnostic sinks, the OpenCode package dependency closure, local Cursor identity, and documentation without changing shared domain boundaries. Release 2 keeps Git-discovered plugin assets in the repository while launching MCP and session-start runtime code from the latest published Cursor npm package, then validates the clean checkout against Cursor's official schemas and component rules.

**Tech Stack:** TypeScript 5.8, React 19, Ink 7, `@inkjs/ui`, Bun 1.3.14, Node 22, OpenCode plugin SDK, Cursor plugin JSON, AJV JSON Schema validation, Bun tests, semantic-release.

## Global Constraints

- Keep core behavior in `packages/workit-core/src/core/`; adapters only map host-native surfaces.
- Require Node `>=22` (Ink 7 requires ≥ 22), including warning-free installation on Node 22.19.
- Preserve persistent JSONL diagnostics, OpenCode native app logs, CLI warning/error stderr, and Cursor protocol-safe stderr.
- Canonical Cursor identity is `workit`; canonical display name is `Workit`.
- Keep `WORKFLOW_TOOLKIT_*`, `.workflow-toolkit-root`, and `~/.local/share/workflow-toolkit` unless they determine Cursor's displayed/local plugin identity.
- Do not add a logger abstraction, React callback abstraction, package manager, Marketplace service, or separate repository.
- Do not commit generated Cursor JavaScript bundles.
- Commit the sanitized Cursor Superpowers skill tree required for Git discovery.
- Marketplace runtime commands use `@brainervirus/workit-cursor@latest` through `npx`.
- Do not publish npm packages, tags, GitHub Releases, or submit the authenticated Cursor publisher form in this plan.
- Follow strict RED/GREEN TDD for every behavior change; run focused tests before broad verification.
- Do not commit during individual tasks. After reviewed implementation, use `wk-commit` and its native confirmation flow.

---

### Task 1: Settle Controlled Wizard Inputs

**Files:**
- Modify: `packages/workit-cli/src/wizard-state.ts:247-272,301-374,498-522`
- Modify: `test/workit-cli/wizard-tty.test.tsx`

**Interfaces:**
- Consumes: existing `reducer(draft: WizardDraft, action: WizardAction): WizardDraft`.
- Produces: unchanged-value `set`, `workspaceDraftName`, and `workspaceDraftGlob` actions return the original `WizardDraft` object; changed values retain existing validation and navigation behavior.

- [ ] **Step 1: Add reducer identity regressions**

Add one table-driven test that dispatches unchanged values for `platforms`, all text fields, `branchPreset`, `vcsProvider`, `applyProject`, workspace draft name/glob, and unchanged branch-policy edits, asserting `reducer(draft, action).toBe(draft)`. Keep separate assertions proving changed values return a different draft with the expected value.

- [ ] **Step 2: Add the idle Ink regression**

Render `Wizard` with `renderInk`, intercept `console.error`, send `SPACE` on the platform screen without `ENTER`, wait for queued effects to settle, and assert the commit/error count stops increasing and no message contains `Maximum update depth exceeded`. Always restore `console.error`, environment variables, and unmount in `finally`.

- [ ] **Step 3: Run the focused test and observe RED**

Run: `bun test test/workit-cli/wizard-tty.test.tsx`

Expected: unchanged reducer assertions fail by receiving new objects, and the idle test observes repeated renders or the React warning.

- [ ] **Step 4: Make reducer updates idempotent**

Before cloning draft state, compare the normalized next value with the current value. Use direct equality for strings/booleans/enums, ordered element equality for `platforms`, and the existing normalized policy values for branch-policy fields. In `setTextValue` and `workspaceDraftText`, return `draft` before cloning `errors` when both the value and resulting validation message are unchanged.

- [ ] **Step 5: Run focused CLI wizard tests and observe GREEN**

Run: `bun test test/workit-cli/wizard-tty.test.tsx test/workit-cli/workspace-wizard.test.tsx`

Expected: PASS with no maximum-depth warning and no idle render growth.

**Criteria:** CA-01 and CA-02 pass without changing the wizard's screen sequence or validation messages.

---

### Task 2: Stop Interactive Structured Log Leakage

**Files:**
- Modify: `packages/workit-cli/src/index.tsx:17-21`
- Modify: `packages/workit-opencode/src/plugin.ts:60-90`
- Modify: `test/workit-cli/packed-cli.test.ts:331-355`
- Modify: `test/workit-opencode/logging.test.ts:97-123`
- Verify: `test/workit-cursor/logging.test.ts`

**Interfaces:**
- Consumes: `createLogger({ appLog?, stderr? })` and existing `DiagnosticEvent.level`.
- Produces: CLI stderr sink writes only `warn` and `error`; OpenCode configures only `appLog`; Cursor logger behavior is unchanged.

- [ ] **Step 1: Add terminal-cleanliness regressions**

In the packed CLI test, assert `help.stderr === ""` and that non-TTY init stderr contains no JSON `initialization` record. In the OpenCode startup test, temporarily replace `process.stderr.write`, invoke the plugin, restore it in `finally`, and assert the captured text is empty while native events still include initialization, provenance, configuration source, and assets.

- [ ] **Step 2: Run focused logging tests and observe RED**

Run: `bun test test/workit-cli/packed-cli.test.ts test/workit-opencode/logging.test.ts`

Expected: FAIL because current adapters mirror `info` events to raw stderr.

- [ ] **Step 3: Apply host-native sink behavior**

Change the CLI sink to return without writing for `debug` and `info`. Remove the OpenCode `stderr` sink entirely and update its adjacent comment to name JSONL plus native app logging. Do not modify `createLogger` or either Cursor logger.

- [ ] **Step 4: Verify all host logging contracts**

Run: `bun test test/workit-core/logger.test.ts test/workit-cli/packed-cli.test.ts test/workit-opencode/logging.test.ts test/workit-cursor/logging.test.ts`

Expected: PASS; CLI/OpenCode routine terminal output is clean, Cursor stderr and protocol-clean stdout assertions remain green.

**Criteria:** CA-03 through CA-05 pass, including visible CLI warning/error behavior.

---

### Task 3: Remove the Published `ini@7` Dependency Path

**Files:**
- Modify: `packages/workit-opencode/scripts/build.ts:45-58`
- Modify: `packages/workit-opencode/package.json:32-42`
- Modify: `test/artifacts/manifests.test.ts:142-167`
- Modify: `test/artifacts/package-contents.test.ts:50-61,128-140`
- Modify: `test/artifacts/packed-runtime.test.ts`
- Modify: `test/artifacts/phase-0-candidate.test.ts`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: OpenCode adapter imports from `@opencode-ai/plugin` and the existing single-file Bun build.
- Produces: `dist/plugin.js` contains the SDK helper/schema runtime it uses; `@opencode-ai/plugin` is development/build-only and absent from packed runtime dependencies; CLI retains all three internal adapter dependencies as setup assets.

- [ ] **Step 1: Change artifact expectations to the intended closure**

Update manifest tests to expect no packed OpenCode runtime dependency named `@opencode-ai/plugin`, while source development metadata still pins `SUPPORT_MATRIX.opencode.current`. Extend packed-content checks to reject unresolved `@opencode-ai/plugin` imports in `dist/plugin.js`. Add an isolated install assertion that `npm install` of the prepared CLI package under Node 22.19 contains neither `EBADENGINE` nor `ini@7` in stderr.

- [ ] **Step 2: Run artifact tests and observe RED**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/package-contents.test.ts test/artifacts/packed-runtime.test.ts test/artifacts/phase-0-candidate.test.ts`

Expected: FAIL because the SDK remains external and is published as a runtime dependency.

- [ ] **Step 3: Bundle the SDK and make it build-only**

Remove the Bun build arguments `--external`, `@opencode-ai/plugin`. Move the exact pinned SDK from `dependencies` to `devDependencies` in `packages/workit-opencode/package.json`. Keep `@brainervirus/workit-core` in `dependencies` for release rewriting and keep CLI adapter dependencies unchanged.

- [ ] **Step 4: Refresh dependencies and build artifacts**

Run: `bun install && bun run build`

Expected: lockfile updates, all package builds complete, and `packages/workit-opencode/dist/plugin.js` has no unresolved SDK import.

- [ ] **Step 5: Verify packed runtime and setup assets**

Run: `bun test test/artifacts test/workit-cli/platform-install.test.ts test/workit-cli/packed-cli.test.ts`

Expected: PASS; packed OpenCode loads, CLI installs both adapters, and no Workit dependency emits the reported engine warning.

**Criteria:** CA-06 and CA-07 pass without raising package engine floors or overriding `ini`.

---

### Task 4: Migrate the Local Cursor Identity to `workit`

**Files:**
- Modify: `packages/workit-core/src/core/registration.ts:28-45,88-116`
- Modify: `packages/workit-core/src/core/setup.ts:492-509,865-948,1009-1155`
- Modify: `packages/workit-core/src/core/sync-runtime.ts:101-314`
- Modify: `packages/workit-core/src/core/doctor.ts:104-132,560-590`
- Modify: `packages/workit-core/scripts/install-cursor-plugin.sh`
- Modify: `packages/workit-core/scripts/sync-runtime.sh`
- Modify: `packages/workit-core/scripts/run-cursor-mcp.sh`
- Modify: `packages/workit-cursor/skills/wk-implement/SKILL.md`
- Modify: `test/artifacts/registration.test.ts`
- Modify: `test/artifacts/cursor-install-invariants.test.ts`
- Modify: `test/shared/helpers/doctor-fixture.ts`
- Modify: `test/workit-core/cursor-install-mcp.test.ts`
- Modify: `test/workit-core/install-scripts.test.ts`
- Modify: `test/workit-core/typescript-parity.test.ts`
- Modify: `test/workit-core/doctor.test.ts`
- Modify: `test/workit-cursor/doctor.test.ts`
- Modify: `test/workit-cli/packed-cli.test.ts`
- Modify: `test/workit-cli/platform-install.test.ts`
- Modify: `test/workit-cli/wizard-config.test.ts`
- Modify: `test/workit-opencode/smoke.ts`
- Modify: `test/workit-opencode/plugin.test.ts`

**Interfaces:**
- Consumes: `isWorkitPlugin`, `mergeCursorEnabledPlugins`, `mergeCursorPluginDirs`, `copyPluginDir`, and setup/sync default paths.
- Produces: canonical directory `~/.cursor/plugins/local/workit`, enabled key `workit`, exact recognition of `workit` and `local/workit`, and post-success cleanup of exact legacy local identities/directories.

- [ ] **Step 1: Add canonical and migration regressions**

Change expected fresh installs to `local/workit` and `enabled_plugins.workit`. Add a migration fixture containing the old directory, old enabled keys, old plugin-dir entries, unrelated similarly named plugins, custom rules, and unrelated settings. Assert the new install is complete before old entries disappear and all unrelated bytes survive.

- [ ] **Step 2: Add failure-order regression**

Force staged plugin installation to fail before final rename and assert the legacy directory and registration remain recoverable. This test must fail if cleanup occurs before replacement succeeds.

- [ ] **Step 3: Run focused identity tests and observe RED**

Run: `bun test test/artifacts/registration.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-cli/platform-install.test.ts test/workit-core/install-scripts.test.ts`

Expected: FAIL on old `workflow-toolkit` defaults and enabled key.

- [ ] **Step 4: Implement canonical identity and ordered cleanup**

Teach `isWorkitPlugin` exact `workit` and `local/workit` identities. Make merge helpers write only `workit` and remove exact legacy Workit entries. Change setup, sync, doctor, and launcher local paths to `~/.cursor/plugins/local/workit`. After `copyPluginDir` and registration succeed, remove only `~/.cursor/plugins/local/workflow-toolkit`; preserve share paths and marker names.

- [ ] **Step 5: Update every parity fixture and host assertion**

Replace local Cursor path expectations in the listed tests and skill documentation. Keep historical/compatibility assertions where they intentionally prove legacy recognition or migration.

- [ ] **Step 6: Run the full identity and installation matrix**

Run: `bun test test/artifacts/registration.test.ts test/artifacts/cursor-install-invariants.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-core/install-scripts.test.ts test/workit-core/typescript-parity.test.ts test/workit-core/doctor.test.ts test/workit-cursor/doctor.test.ts test/workit-cli test/workit-opencode`

Expected: PASS; fresh and migrated installs converge on one `workit` plugin.

**Criteria:** CA-08 through CA-10 pass with idempotent migration and preserved unrelated state.

---

### Task 5: Refresh Release 1 Documentation and Verification

**Files:**
- Modify: `README.md`
- Replace: `packages/workit-core/README.md`
- Modify: `packages/workit-cli/README.md`
- Modify: `packages/workit-opencode/README.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: verified behavior and package scripts from Tasks 1-4.
- Produces: root product reference plus package-specific balanced references; Unreleased reliability entries; explicit source-manifest versus release-time version explanation.

- [ ] **Step 1: Rewrite docs from verified behavior**

Use the documentation scope table in the spec. Remove stale Bun runtime claims for published artifacts, stale tool counts, generalized host behavior, unsupported provenance/CI claims, obsolete paths, and the stale core README copy. Document approval, implementation, commit, and handoff differences in one root host-capability table.

- [ ] **Step 2: Document Release 1 operations**

Document Node 22+, `workit init`, `workit doctor [--json]`, local Cursor path `~/.cursor/plugins/local/workit`, OpenCode native logging, configuration migration, package-local scripts, actual CI topology, and semantic-release's CI-only package version rewrite.

- [ ] **Step 3: Update repository contract and changelog**

Add Marketplace distribution as a host-native parity consideration in `AGENTS.md`. Add concise Unreleased Fixed/Changed entries for the wizard loop, terminal log leakage, Node warning, and Cursor identity migration. Do not invent `0.6.1` or `0.7.1` headings without corresponding release facts in Git; explain current source/published version divergence instead.

- [ ] **Step 4: Verify Release 1**

Run: `bun run check && bun run verify:release-candidate`

Expected: PASS. Then run a clean packed CLI install with Node 22.19 and verify `workit --help`, non-TTY init, OpenCode package loading, and Cursor local installation produce the documented behavior.

**Criteria:** CA-11, CA-12, and the Release 1 half of CA-20 through CA-22 pass. Stop here for Release 1 review and later npm publication through the repository's normal release workflow.

---

### Task 6: Add Cursor npm Runtime Executables

**Files:**
- Modify: `packages/workit-cursor/package.json:20-47`
- Modify: `packages/workit-cursor/scripts/build.ts:41-72`
- Modify: `test/artifacts/package-contents.test.ts:63-82`
- Modify: `test/artifacts/manifests.test.ts:26-71`
- Modify: `test/artifacts/packed-runtime.test.ts`
- Modify: `test/artifacts/phase-0-candidate.test.ts`

**Interfaces:**
- Produces npm executables `workit-cursor-mcp` -> `./dist/mcp-server.js` and `workit-cursor-session-start` -> `./dist/cursor-session-start.js`.
- Later tasks consume exact commands `npx -y --package=@brainervirus/workit-cursor@latest workit-cursor-mcp` and `npx -y --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`.

- [ ] **Step 1: Add packed-bin regressions**

Assert the packed Cursor `package.json` exposes both exact bin names and paths. Install the tarball in isolation, invoke each executable through npm's package runner, and assert MCP `tools/list` plus session-start JSON output remain protocol-valid on Node 22.

- [ ] **Step 2: Run focused artifact tests and observe RED**

Run: `bun test test/artifacts/package-contents.test.ts test/artifacts/manifests.test.ts test/artifacts/packed-runtime.test.ts test/artifacts/phase-0-candidate.test.ts`

Expected: FAIL because no Cursor bins are declared.

- [ ] **Step 3: Declare the existing built entries as package bins**

Add:

```json
"bin": {
  "workit-cursor-mcp": "./dist/mcp-server.js",
  "workit-cursor-session-start": "./dist/cursor-session-start.js"
}
```

Keep the existing Node shebang banners and do not add wrapper files.

- [ ] **Step 4: Build and verify the npm runtime candidate**

Run: `bun run build && bun test test/artifacts && bun run verify:release-candidate`

Expected: PASS; both executable entries run from the packed package.

**Criteria:** The package half of CA-16 passes. Release 2 must not continue until a public `@brainervirus/workit-cursor@latest` containing these bins is available.

---

### Task 7: Add Marketplace Metadata, Logo, and Git-Discovered Skills

**Files:**
- Create: `.cursor-plugin/marketplace.json`
- Modify: `packages/workit-cursor/.cursor-plugin/plugin.json`
- Delete: `packages/workit-cursor/marketplace.json`
- Create: `packages/workit-cursor/assets/logo.svg`
- Modify: `.gitignore`
- Add: `packages/workit-cursor/vendor/superpowers/skills/**`
- Modify: `packages/workit-cursor/scripts/build.ts:82-94`
- Modify: `packages/workit-core/scripts/rewrite-workspace-deps.ts:27-35`
- Modify: `test/workit-core/rewrite-workspace-deps.test.ts`
- Modify: `test/artifacts/manifests.test.ts`
- Modify: `test/artifacts/package-contents.test.ts`
- Modify: `test/artifacts/cursor-install-invariants.test.ts`

**Interfaces:**
- Produces root marketplace index `workit` -> `packages/workit-cursor`; plugin metadata with `name: "workit"`, `displayName: "Workit"`, author/publisher/repository/homepage/license/keywords/category/tags/logo; deterministic tracked 14-skill vendor tree.

- [ ] **Step 1: Add metadata and clean-checkout regressions**

Assert the root index points to `packages/workit-cursor`, the package manifest contains complete metadata and `assets/logo.svg`, the obsolete flat package marketplace file is absent, and all 26 declared skill manifests plus four rules exist in `git ls-files` rather than only after a build.

- [ ] **Step 2: Run focused manifest tests and observe RED**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/package-contents.test.ts test/artifacts/cursor-install-invariants.test.ts test/workit-core/rewrite-workspace-deps.test.ts`

Expected: FAIL on missing root index/logo/tracked vendor assets and old package marketplace assumptions.

- [ ] **Step 3: Add canonical Marketplace metadata**

Create the root index with owner `BrainerVirus` and one plugin source `packages/workit-cursor`. Complete the package plugin manifest using repository URL `https://github.com/BrainerVirus/workit`, MIT license, and a relative `assets/logo.svg`. Use a minimal ASCII-text SVG mark with no fonts, scripts, remote resources, or embedded raster data.

- [ ] **Step 4: Track deterministic sanitized vendor skills**

Change `.gitignore` to keep Cursor `dist/` ignored while allowing `packages/workit-cursor/vendor/superpowers/skills/`. Run `bun packages/workit-cursor/scripts/build.ts`, stage only the generated sanitized skill tree conceptually for later `wk-commit`, and ensure build output is deterministic.

- [ ] **Step 5: Remove obsolete metadata rewrite paths**

Delete the package-level `marketplace.json` and stop release rewriting it. Keep release-time version rewriting for `.cursor-plugin/plugin.json`; the root index carries no release version.

- [ ] **Step 6: Verify metadata and tracked assets**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/package-contents.test.ts test/artifacts/cursor-install-invariants.test.ts test/workit-core/rewrite-workspace-deps.test.ts`

Expected: PASS with no ignored-file dependency.

**Criteria:** CA-13 through CA-15 pass.

---

### Task 8: Point the Marketplace Plugin at `@latest`

**Files:**
- Modify: `packages/workit-cursor/mcp.json`
- Modify: `packages/workit-cursor/hooks/hooks-cursor.json`
- Delete: `packages/workit-cursor/hooks/session-start`
- Delete: `packages/workit-cursor/mcp/run-server.sh`
- Modify: `packages/workit-cursor/package.json`
- Modify: `packages/workit-core/src/core/registration.ts:181-215`
- Modify: `packages/workit-core/src/core/setup.ts:808-915`
- Modify: `packages/workit-core/scripts/install-cursor-plugin.sh`
- Modify: `packages/workit-core/scripts/run-cursor-mcp.sh`
- Modify: `test/artifacts/manifests.test.ts`
- Modify: `test/artifacts/package-contents.test.ts`
- Modify: `test/workit-core/cursor-install-mcp.test.ts`
- Modify: `test/workit-core/install-scripts.test.ts`
- Modify: `test/workit-cursor/mcp-process.test.ts`

**Interfaces:**
- Consumes: public bins from Task 6.
- Produces: MCP command `npx` with args `-y`, `--package=@brainervirus/workit-cursor@latest`, `workit-cursor-mcp`, `${workspaceFolder}`; session-start hook command string `npx -y --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`.

- [ ] **Step 1: Confirm the public runtime gate**

Run: `npm view @brainervirus/workit-cursor@latest bin engines --json`

Expected: both Task 6 bin names are present and engines includes Node 22. If not, stop Release 2; do not point the Marketplace plugin at an unavailable command.

- [ ] **Step 2: Add manifest and process regressions**

Assert committed and installed MCP configs use the exact `npx` command/args above, hook entries contain one `command` string and no `args`, no active manifest references local `dist`, and a real process smoke reaches both public npm bins.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `bun test test/artifacts/manifests.test.ts test/artifacts/package-contents.test.ts test/workit-core/cursor-install-mcp.test.ts test/workit-core/install-scripts.test.ts test/workit-cursor/mcp-process.test.ts`

Expected: FAIL on current Node/dist launchers and hook `args` shape.

- [ ] **Step 4: Replace local runtime launchers with npm commands**

Update `mcp.json` and `hooks/hooks-cursor.json` to the exact produced interfaces. Remove obsolete shell launchers and package file-list entries. Simplify installed-manifest generation so setup copies the Marketplace-safe command rather than deriving an absolute `dist` path.

- [ ] **Step 5: Verify local and public runtime behavior**

Run: `bun test test/artifacts test/workit-core/cursor-install-mcp.test.ts test/workit-core/install-scripts.test.ts test/workit-cursor`

Expected: PASS; stdout remains protocol-only and network/startup errors surface through Cursor diagnostics.

**Criteria:** CA-16 and CA-17 pass with the user-selected mutable `@latest` trade-off.

---

### Task 9: Add Official Schema and Clean-Checkout Marketplace Gates

**Files:**
- Create: `packages/workit-core/scripts/validate-cursor-marketplace.ts`
- Create: `test/fixtures/cursor-schemas/plugin.schema.json`
- Create: `test/fixtures/cursor-schemas/marketplace.schema.json`
- Create: `test/artifacts/cursor-marketplace.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `packages/workit-cursor/README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/reliability-marketplace-readiness/spec.md` only if implementation evidence requires a factual correction

**Interfaces:**
- Produces: `bun run validate:cursor-marketplace`, validating official schema snapshots, tracked component paths/frontmatter/logo, sanitized vendor parity, npm bin declarations, and clean-checkout independence from ignored files.

- [ ] **Step 1: Add official schema snapshots with provenance**

Copy the current official schemas from `https://github.com/cursor/plugins/tree/main/schemas` verbatim into `test/fixtures/cursor-schemas/`. Record source URLs and retrieval date in the validator/test comments. Add AJV and `ajv-formats` as pinned root dev dependencies only if they are not already directly available.

- [ ] **Step 2: Write the failing Marketplace validator test**

Run validation against a temporary copy populated only from `git ls-files`. Assert both JSON schemas pass, every manifest path resolves inside the plugin root, all declared skills/rules have valid frontmatter, the logo exists, no active runtime path targets ignored `dist`, and rebuilding sanitized vendor skills yields no diff.

- [ ] **Step 3: Run the new test and observe RED**

Run: `bun test test/artifacts/cursor-marketplace.test.ts`

Expected: FAIL until the validator and package script exist.

- [ ] **Step 4: Implement the smallest validator and CI command**

Use AJV only for official JSON Schema evaluation; use existing `validateSkillManifests`, filesystem checks, and Git tracked-file output for repository-specific invariants. Add root script `validate:cursor-marketplace` and run it in the existing Cursor and candidate CI jobs after build/pack gates.

- [ ] **Step 5: Finish Marketplace documentation**

Document local and Marketplace installation, Node/network requirements, `npx @latest` review drift, MCP/hook process execution, Git/VCS/YouTrack/filesystem interactions, persistent redacted logs, secret storage, troubleshooting, manual update review, and the authenticated submission URL. Update `AGENTS.md` parity rules and add Unreleased Added/Changed entries without claiming submission or acceptance.

- [ ] **Step 6: Run final clean-checkout verification**

Run: `bun run check && bun run verify:release-candidate && bun run validate:cursor-marketplace`

Expected: PASS. Copy the tracked plugin into `~/.cursor/plugins/local/workit`, reload Cursor, and verify the `Workit` display name, four rules, 26 skills, MCP server, and session-start hook. Record any host-only manual observation without treating it as a substitute for automated gates.

- [ ] **Step 7: Validate workflow documents and implementation traceability**

Run the registered `workflow_docs_validate` tool for the spec/plan pair, then confirm every CA-01 through CA-22 has test or documentation evidence in the implementation review package.

**Criteria:** CA-18 through CA-22 pass and the repository is ready, but not submitted, at `https://cursor.com/marketplace/publish`.

| Status | Task |
| --- | --- |
| pending | 1: Settle controlled wizard inputs |
| pending | 2: Stop interactive structured log leakage |
| pending | 3: Remove the published `ini@7` dependency path |
| pending | 4: Migrate the local Cursor identity to `workit` |
| pending | 5: Refresh Release 1 documentation and verification |
| pending | 6: Add Cursor npm runtime executables |
| pending | 7: Add Marketplace metadata, logo, and Git-discovered skills |
| pending | 8: Point the Marketplace plugin at `@latest` |
| pending | 9: Add official schema and clean-checkout Marketplace gates |
