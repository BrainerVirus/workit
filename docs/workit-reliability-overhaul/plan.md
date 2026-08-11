# Workit Reliability Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/workit-reliability-overhaul/spec.md`
**Branch:** `feature/workit-reliability-overhaul`

**Goal:** Deliver self-contained, diagnosable Workit packages and structurally enforced workflows across OpenCode, Cursor, and the CLI without publishing a release.

**Architecture:** Keep domain, path, migration, configuration, logging, doctor, and flow behavior in a host-neutral TypeScript core. Build thin OpenCode, Cursor, and CLI adapters into package-local JavaScript artifacts, then prove those artifacts from isolated homes and unrelated working directories before each phase advances.

**Tech Stack:** TypeScript, Bun 1.3.14, Node.js 20+, React/Ink, OpenCode plugin SDK, Model Context Protocol SDK, GitHub Actions, and Bun's test runner.

## Global Constraints

- Tasks 1-23 and Phases 0-8 are historical completed implementation; execute Phase 9 Tasks 24-31 in order and do not treat earlier green evidence as closure for a post-implementation finding.
- Every production change requires observed RED evidence, the minimum GREEN implementation, focused verification, and `bun run check`; retain the failing command and reason in SDD progress.
- Keep each phase releasable, reversible, and independently reviewed; do not mix unrelated later-phase work.
- Keep maintained first-party runtime logic in TypeScript and publish only compiled, self-contained JavaScript entries.
- Pin Bun for development, build, and test; published CLI, MCP, hook, and plugin artifacts run on Node.js 20+ without Bun, Bash, raw TypeScript, runtime installation, monorepo hoisting, or checkout-relative imports.
- Keep core free of OpenCode SDK, MCP SDK, Ink, and host-hook dependencies; adapters own host registration and presentation.
- Run artifact and host tests from extracted tarballs, temporary homes, unrelated working directories, and environments where repository dependencies are unavailable.
- Never log prompts, messages, content, raw tool arguments/results, credentials, tokens, authorization headers, issue data, URL queries, home prefixes, or unbounded stacks.
- Preserve existing credentials and unrelated host configuration byte-for-byte unless a reviewed mutation explicitly replaces them.
- Legacy migration is native-question-confirmed, copy-only, no-clobber, recoverable, idempotent, and never deletes source files.
- OpenCode approvals/menu choices use host-observed one-use question receipts and host-derived session parentage. Cursor confirmations are audited with `attested: false`; Cursor accepts no delegated role and blocks unsupported subagent-driven mutation.
- Keep workflow-managed SDD state only at `docs/<slug>/sdd/`; never add an extra slug level or create an empty progress ledger.
- Do not advertise Deno or add Codex-specific behavior without an executable host matrix.
- Do not publish packages, tags, registry releases, or marketplace releases in this plan.

## Delivery Flow

```mermaid
flowchart LR
  %% Reliability Remediation Delivery
  recovery["Pre-phase: runtime recovery"]
  p0["Phase 0: safety candidate"]
  p1["Phase 1: typed boundaries"]
  p2["Phase 2: packed artifacts"]
  p3["Phase 3: logs and doctor"]
  p4["Phase 4: setup wizard"]
  p5["Phase 5: docs migration"]
  p6["Phase 6: structural gates"]
  p7["Phase 7: config and VCS"]
  p8["Phase 8: initial release proof"]
  p9["Phase 9: audit remediation and final proof"]
  recovery -->|CA-32| p0
  p0 -->|corrective candidate| p1
  p1 -->|host-neutral core| p2
  p2 -->|isolated artifacts| p3
  p3 -->|doctor contract| p4
  p4 -->|safe apply model| p5
  p5 -->|canonical paths| p6
  p6 -->|capability-aware flow| p7
  p7 -->|reliability gate| p8
  p8 -->|independent audit findings| p9
```

## Traceability

| Phase | Tasks | Requirements | Acceptance criteria |
| --- | --- | --- | --- |
| Recovery | 1 | RR-05 recovery baseline | CA-02, CA-31, CA-32 |
| 0 | 2-4 | RR-01, RR-03, RR-04, RR-05, RR-11, WZ-05, WZ-06, minimum WZ-09/WZ-10 | CA-02, CA-03, CA-05, CA-06, CA-08, CA-12, CA-13, CA-22, CA-30, CA-31 |
| 1 | 5 | PT-01, PT-05, RR-04, RR-08, DC-14 prerequisite | CA-06, CA-07, CA-31 |
| 2 | 6-8 | RR-02, RR-03, RR-06-RR-10, PT-02-PT-12, runtime portion of RL-09 | CA-03-CA-08, CA-25-CA-27, CA-31 |
| 3 | 9-11 | DG-01-DG-10, final RR-05/RR-06 verification | CA-04, CA-09, CA-10, CA-25, CA-28, CA-31 |
| 4 | 12-15 | WZ-01-WZ-16, RL-02, RL-06 | CA-11-CA-14, CA-22, CA-23, CA-31 |
| 5 | 16-18 | DC-01-DC-14 | CA-15-CA-17, CA-28, CA-31 |
| 6 | 19-20 | FG-01-FG-09 | CA-18-CA-21, CA-28, CA-31 |
| 7 | 21-22 | RL-01-RL-07, RL-09 | CA-22-CA-25, CA-31 |
| 8 | 23 | RL-08, RL-10, all audit and Ponytail closure | CA-01, CA-02, CA-04, CA-05, CA-08, CA-26-CA-31 |
| 9 | 24-31 | AR-01-AR-15; corrected FG-04, FG-05, FG-09 | CA-18-CA-20, CA-33-CA-45 |

---

### Task 1: Close the restarted OpenCode recovery gate

**Requirements:** RR-05 recovery baseline; CA-02, CA-31, CA-32.

**Files:**
- Modify only if a gap is reproduced: `packages/workit-core/scripts/install-opencode-plugin.sh`
- Test: `test/workit-core/install-scripts.test.ts`
- Evidence: `docs/workit-reliability-overhaul/sdd/progress.md`

**Interfaces:** Preserve the direct `file://.../packages/workit-opencode/src/plugin.ts` pin, first-position priority, Workit identity deduplication, and explicit missing-entry failure already merged in PR #38.

- [ ] **Step 1: Reproduce the host-level RED check**
  Run fresh `opencode debug config` and `opencode debug skill` processes against an isolated stale `git+file://` fixture; record that `wk-status`, `wk-implement`, Workit tools/bootstrap assets, or vendored brainstorming are absent.
- [ ] **Step 2: Verify the repository recovery regression**
  Run `bun test test/workit-core/install-scripts.test.ts`; expected GREEN is `3 pass, 0 fail`. Do not change production code if the existing recovery remains sufficient.
- [ ] **Step 3: Apply the recovered development entry and restart fully**
  Run the installer from the active checkout, fully terminate OpenCode processes, and start new debug processes so configuration is not served from process cache.
- [ ] **Step 4: Capture GREEN host evidence**
  Record exact debug commands and matching entries for `wk-status`, `wk-implement`, Workit tools/bootstrap assets, and brainstorming. If any entry remains absent, add one failing automated assertion before the minimum installer correction.
- [ ] **Step 5: Run the recovery gate**
  Run `bun test test/workit-core/install-scripts.test.ts && bun run check`; expected result is all checks green and no registry operation.
- [ ] **Step 6: Review and checkpoint**
  Record rollback as restoration of the prior local config entry only; if repository files changed, request a reviewed `wk-commit` commit before Phase 0.

**Criteria:** CA-32 is evidenced by restarted host processes, the installer regression passes, and no package is downloaded or published.

### Task 2: Correct release metadata and Cursor initialization

**Requirements:** RR-01, RR-03, RR-04, RR-11; CA-03, CA-05, CA-06, CA-30, CA-31.

**Files:**
- Modify: `package.json`, `tsconfig.json`, `release.config.cjs`
- Modify: `packages/workit-core/scripts/rewrite-workspace-deps.ts`
- Modify: `packages/workit-core/package.json`, `packages/workit-opencode/package.json`, `packages/workit-cursor/package.json`, `packages/workit-cli/package.json`
- Modify: `packages/workit-cursor/mcp/server.ts`, `packages/workit-cursor/mcp.json`, `packages/workit-cursor/marketplace.json`, `packages/workit-cursor/hooks/hooks-cursor.json`, `packages/workit-cursor/mcp/run-server.sh`
- Test: `test/workit-core/rewrite-workspace-deps.test.ts`, `test/workit-cursor/mcp-regressions.test.ts`, `test/workit-cursor/mcp-process.test.ts`

**Interfaces:** Produce a release-version consistency check, a package-local Cursor launcher, strict Cursor inclusion in root typechecking, typed `jsonResult`, and one normalized optional workspace root passed to every handler.

- [ ] **Step 1: Write the failing metadata and MCP process regressions**
  Assert that every prepared adapter dependency equals the prepared core version, Cursor manifests stay package-relative, root typecheck includes Cursor, and an MCP `initialize` plus `tools/list` process reaches every representative handler without `workspace_root` faults.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/rewrite-workspace-deps.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-cursor/mcp-process.test.ts && bun run typecheck`; expected failure is mismatched prepared metadata, an external launcher, omitted Cursor source, or strict Cursor typing errors.
- [ ] **Step 3: Implement the minimum correction**
  Make release preparation synchronize and validate versions before packing, include Cursor in strict typechecking, normalize `workspaceRoot` once, type MCP success/error results, and point manifests at package-local entries without performing the Phase 2 bundle rewrite.
- [ ] **Step 4: Run GREEN**
  Re-run the RED command; expected result is all focused tests and strict typecheck green.
- [ ] **Step 5: Refactor only while green**
  Remove duplicated workspace-root normalization and result casts only when the focused tests remain green.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, review the task diff, and request `wk-commit` with `fix(cursor): correct release metadata and initialization`.

**Criteria:** Prepared metadata is internally consistent, Cursor initializes from package-local paths, and strict typechecking covers every registered handler.

### Task 3: Stop installer, wizard, and credential false success

**Requirements:** RR-05, WZ-05, WZ-06, minimum WZ-09/WZ-10; CA-12, CA-13, CA-22, CA-31.

**Files:**
- Modify: `packages/workit-core/scripts/install-cursor-plugin.sh`, `packages/workit-core/scripts/install-opencode-plugin.sh`, `packages/workit-core/scripts/sync-runtime.sh`
- Modify: `packages/workit-cli/src/logic.ts`, `packages/workit-cli/src/steps.tsx`
- Test: `test/workit-core/install-scripts.test.ts`, `test/workit-cli/cli-logic.test.ts`, `test/workit-cli/scaffold-parity.test.ts`

**Interfaces:** `scaffoldYouTrack` and `scaffoldVcs` return typed missing/malformed/preserved outcomes; required installer failures and selected-but-unconfigured hosts produce nonzero status and no unconditional success line.

- [ ] **Step 1: Write failing safety regressions**
  Add fixtures for an existing token, malformed configuration, a missing required utility, public clone fallback, lock/dependency failure, and a selected host with no completed installation.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/install-scripts.test.ts test/workit-cli/cli-logic.test.ts test/workit-cli/scaffold-parity.test.ts`; expected failure is token replacement, malformed state treated as empty, SSH-only cloning, or zero exit after a required failure.
- [ ] **Step 3: Implement the minimum safety behavior**
  Preserve credential bytes, create placeholders only when absent, return blocking malformed-state diagnostics, use a public HTTPS clone URL, propagate required failures, and suppress platform success unless configuration completed.
- [ ] **Step 4: Run GREEN**
  Re-run the focused command; expected result is all safety fixtures green.
- [ ] **Step 5: Refactor only while green**
  Share one typed scaffold result shape without beginning the Phase 4 wizard state-machine rewrite.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, review preservation/failure paths, and request `wk-commit` with `fix(init): preserve credentials and report failures`.

**Criteria:** Existing credentials survive byte-for-byte, malformed files block mutation, and required installation failures cannot report success.

### Task 4: Pack and gate the Phase 0 corrective candidate

**Requirements:** RR-11 and Phase 0 closure; CA-02, CA-03, CA-05, CA-06, CA-08, CA-30, CA-31.

**Files:**
- Create: `test/artifacts/phase-0-candidate.test.ts`
- Create: `test/shared/helpers/packages.ts`
- Modify: `.github/workflows/ci.yml`
- Evidence: `docs/workit-reliability-overhaul/sdd/progress.md`

**Interfaces:** `packWorkspacePackages(): Array<{ packageName: string; tarball: string; sha256: string }>`; extracted-package helpers run commands with repository dependencies unavailable.

- [ ] **Step 1: Write the failing artifact test**
  Pack all packages without publishing and assert synchronized metadata, expected entry files, valid dependency ranges, package-local Cursor startup, preserved credentials, and nonzero required failures in temporary homes.
- [ ] **Step 2: Run RED**
  Run `bun test test/artifacts/phase-0-candidate.test.ts`; expected failure is at least one current metadata, launcher, isolated startup, or failure-propagation defect.
- [ ] **Step 3: Implement only candidate-gate support**
  Add deterministic pack helpers and CI invocation; correct only defects required to satisfy the Phase 0 scope.
- [ ] **Step 4: Run GREEN**
  Re-run the artifact test; expected result is a clean extracted candidate with no publication command.
- [ ] **Step 5: Run the Phase 0 gate**
  Run `bun test test/workit-core/rewrite-workspace-deps.test.ts test/workit-core/install-scripts.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-cursor/mcp-process.test.ts test/workit-cli/cli-logic.test.ts test/artifacts/phase-0-candidate.test.ts && bun run check`.
- [ ] **Step 6: Record rollback and checkpoint**
  Record packed filenames/checksums, advisories, rollback to the previous local candidate, and explicit `not published`; request `wk-commit` with `test(release): gate the corrective candidate`.

**Criteria:** Phase 0 candidate artifacts install and start in isolation, all safety checks pass, and no publish/tag/marketplace operation occurs.

### Task 5: Establish strict TypeScript and host-neutral boundaries

**Requirements:** PT-01, PT-05, RR-04, RR-08, DC-14 prerequisite; CA-06, CA-07, CA-31.

**Files:**
- Modify: `tsconfig.json`, root and package `package.json` files
- Modify/split: `packages/workit-core/src/tools/*.ts`, `packages/workit-core/src/core.ts`, `packages/workit-opencode/src/plugin.ts`, `packages/workit-cursor/mcp/server.ts`
- Create: `test/workit-core/host-boundaries.test.ts`
- Test: `test/workit-cursor/mcp-regressions.test.ts`, `test/workit-opencode/plugin.test.ts`

**Interfaces:** Core exports host-neutral functions and `Result<T>` only; OpenCode owns `tool(...)` wrappers; Cursor owns MCP schemas/registration; each adapter receives an explicit normalized workspace root and dependency object.

- [ ] **Step 1: Write failing boundary tests**
  Assert that core imports no host SDK/MCP SDK/Ink module, every maintained TS entry is typechecked, Cursor normalization occurs once, and representative OpenCode/Cursor registrations call the same pure core functions.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/host-boundaries.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-opencode/plugin.test.ts && bun run typecheck`; expected failure is forbidden core imports, omitted source, or inconsistent adapter inputs.
- [ ] **Step 3: Move only adapter registration**
  Relocate host wrappers/dependencies to their packages, preserve pure behavior and result envelopes in core, and inject host clients/runtimes explicitly.
- [ ] **Step 4: Run GREEN**
  Re-run the RED command; expected result is strict typing and boundary assertions green.
- [ ] **Step 5: Refactor only while green**
  Split files only where registration and domain logic remain coupled; do not begin packaging changes.
- [ ] **Step 6: Run the Phase 1 gate and checkpoint**
  Run `bun test test/workit-core/host-boundaries.test.ts test/workit-cursor/mcp-regressions.test.ts test/workit-opencode/plugin.test.ts && bun run typecheck && bun run check`; request `wk-commit` with `refactor(core): separate host adapters`.

**Criteria:** Every maintained TS surface is strict-checked, core is host-neutral, and both adapters preserve representative behavior.

### Task 6: Port maintained shell behavior to shared TypeScript

**Requirements:** PT-01-PT-04, PT-09, runtime portion of RL-09; CA-05, CA-07, CA-25, CA-31.

**Files:**
- Modify: `packages/workit-core/src/core/*.ts`, `packages/workit-core/src/tools/repo.ts`, `packages/workit-core/src/core/scripts.ts`
- Remove after migration: delegating files under `packages/workit-core/scripts/`
- Modify: `packages/workit-cursor/hooks/session-start*`, `packages/workit-cursor/mcp/run-server.sh`
- Create: `test/workit-core/typescript-parity.test.ts`, `test/workit-cursor/runtime-parity.test.ts`
- Test: `test/workit-core/repo.test.ts`, `test/workit-core/workspaces-scripts.test.ts`, `test/workit-core/youtrack.test.ts`

**Interfaces:** Replace `RepoRuntime.runScript` with typed Git/context/verification/install operations; standalone commands expose compiled Node bins; use `fetch`, `path.delimiter`, and Node-compatible APIs.

- [ ] **Step 1: Capture shell parity in failing tests**
  Add cases for every maintained Git/range/context/verification/install/sync/launcher/hook path, including spaces, Windows delimiters, nonzero exits, and session start with network unavailable.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/typescript-parity.test.ts test/workit-cursor/runtime-parity.test.ts`; expected failure is a behavior reachable only through shell, runtime `curl`, colon-only PATH handling, or implicit network sync.
- [ ] **Step 3: Port the minimum shared behavior**
  Implement typed core operations, migrate callers, remove `runScript` indirection, and switch Cursor launch/hook execution to Node-compatible TS entry sources.
- [ ] **Step 4: Run GREEN**
  Re-run the parity tests plus `bun test test/workit-core/repo.test.ts test/workit-core/workspaces-scripts.test.ts test/workit-core/youtrack.test.ts`.
- [ ] **Step 5: Remove obsolete wrappers while green**
  Delete only delegating first-party shell paths with no remaining caller; retain vendored upstream data outside active runtime packages.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, verify no startup network update remains, and request `wk-commit` with `refactor(runtime): port maintained shell behavior`.

**Criteria:** Maintained runtime behavior is TypeScript, no active first-party shell or implicit startup update is required, and captured parity remains green.

### Task 7: Build self-contained adapters and deterministic assets

**Requirements:** RR-02, RR-03, RR-07-RR-09, PT-06-PT-08, PT-10; CA-03, CA-05, CA-07, CA-08, CA-27, CA-31.

**Files:**
- Modify: root and package `package.json` build/files/exports entries
- Modify: `packages/workit-core/scripts/rewrite-workspace-deps.ts`
- Create: adapter build scripts under `packages/*/scripts/`
- Create generated outputs: `packages/workit-opencode/dist/plugin.js`, `packages/workit-cursor/dist/mcp-server.js`, `packages/workit-cursor/dist/cursor-session-start.js`, `packages/workit-cli/dist/index.js`
- Create: `test/artifacts/package-contents.test.ts`, `test/artifacts/packed-runtime.test.ts`

**Interfaces:** Each package exposes one package-local JavaScript entry and deterministic `assets/` roots for commands, skills, rules, templates, hygiene, and filtered vendor content; CLI output is nonsplitting with a portable Node shebang.

- [ ] **Step 1: Write failing package-content and process tests**
  Assert extracted tarballs contain required entries/assets and contain no runtime `.ts`, `workspace:*`, source subpath imports, split CLI chunks, checkout paths, active vendored shell references, or undeclared dependency resolution.
- [ ] **Step 2: Run RED**
  Run `bun test test/artifacts/package-contents.test.ts test/artifacts/packed-runtime.test.ts`; expected failure is current raw TS, external/share paths, split output, missing assets, or workspace dependency behavior.
- [ ] **Step 3: Implement minimum package builds**
  Bundle core and runtime dependencies into adapter entries, copy deterministic assets, filter vendor executables/references, correct exports/files, and remove release rewriting only after final tarballs prove it unnecessary.
- [ ] **Step 4: Run GREEN**
  Re-run both artifact suites from extracted packages with repository `node_modules` unavailable.
- [ ] **Step 5: Refactor only while green**
  Share build/copy logic only where outputs are identical; retain package-specific manifests and entry names.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, inspect all tarball manifests, and request `wk-commit` with `build(packages): add self-contained adapters`.

**Criteria:** OpenCode, Cursor MCP/hook, and CLI execute package-local JavaScript with explicit assets and no monorepo/runtime-install dependency.

### Task 8: Correct registration, manifests, pins, and the platform matrix

**Requirements:** RR-06, RR-07, RR-10, PT-05, PT-11, PT-12; CA-03-CA-08, CA-26, CA-27, CA-31.

**Files:**
- Modify: OpenCode/Cursor manifests and installer registration modules
- Modify: `.github/workflows/ci.yml`, `bun.lock`, package SDK declarations
- Create: `test/artifacts/registration.test.ts`, `test/artifacts/manifests.test.ts`
- Extend: `test/artifacts/packed-runtime.test.ts`

**Interfaces:** Registration merge functions accept existing user config and return deduplicated config plus explicit changes; manifests invoke Node explicitly; CI constants pin Bun 1.3.14, declared Node versions, and declared minimum/current OpenCode versions.

- [ ] **Step 1: Write failing registration, manifest, and matrix assertions**
  Cover duplicate legacy/current identities, unrelated config preservation, package-relative manifest paths, Node invocation, pinned toolchains, Linux/macOS/Windows, and minimum/current OpenCode loading.
- [ ] **Step 2: Run RED**
  Run `bun test test/artifacts/registration.test.ts test/artifacts/manifests.test.ts test/artifacts/packed-runtime.test.ts`; expected failure is duplicate registration, invalid schema, unpinned CI, or nonportable invocation.
- [ ] **Step 3: Implement the minimum corrections**
  Merge/deduplicate registrations, fix manifests, pin supported versions, and add executable matrix jobs without advertising Deno.
- [ ] **Step 4: Run GREEN**
  Re-run focused artifact tests and the local build; expected result is package-relative registration and manifest integrity green.
- [ ] **Step 5: Run the Phase 2 gate**
  Run `bun test test/workit-core/typescript-parity.test.ts test/workit-cursor/runtime-parity.test.ts test/artifacts/package-contents.test.ts test/artifacts/packed-runtime.test.ts test/artifacts/registration.test.ts test/artifacts/manifests.test.ts && bun run check`; require CI green on all declared matrix jobs.
- [ ] **Step 6: Record rollback and checkpoint**
  Preserve prior package artifacts/checksums for rollback and request `wk-commit` with `fix(packages): validate registrations and manifests`.

**Criteria:** Extracted packages register once, manifests are portable, pinned support-matrix jobs pass, and no Deno support is claimed.

### Task 9: Implement the secret-safe structured logger

**Requirements:** DG-01-DG-03, DG-05, DG-10; CA-10, CA-31.

**Files:**
- Create: `packages/workit-core/src/core/logger.ts`
- Create: `test/workit-core/logger.test.ts`
- Modify adapters only for sink injection: OpenCode, Cursor MCP/hook, CLI entry modules

**Interfaces:** Define `type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }`; export `createLogger(options: LoggerOptions): Logger` and `redact(value: unknown): JsonValue`, with event methods that append sanitized JSONL; inject OpenCode app-log and stderr sinks without writing MCP stdout.

- [ ] **Step 1: Write failing logger contract tests**
  Cover valid JSONL, daily filenames, seven-file retention, mode `0600` where supported, concurrent append completeness, stderr/protocol separation, detector isolation, rate limiting, and canaries for secrets/content/queries/home paths/stacks.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/logger.test.ts`; expected failure is missing logger behavior.
- [ ] **Step 3: Implement the dependency-free logger**
  Use platform state directories, append-only JSONL, restrictive creation modes, deterministic retention, bounded fields/stacks, recursive redaction, and injected optional sinks.
- [ ] **Step 4: Run GREEN**
  Re-run logger tests; expected result is no canary leakage, no lost records, and protocol stdout untouched.
- [ ] **Step 5: Refactor only while green**
  Keep the public event schema small and avoid operation timing until sparse diagnostics prove insufficient.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(diagnostics): add structured logger`.

**Criteria:** Logs are valid, bounded, concurrent-safe, restrictive, protocol-safe, and contain no prohibited user or secret data.

### Task 10: Instrument runtime boundaries and MCP domain failures

**Requirements:** DG-03-DG-06, DG-10; CA-10, CA-25, CA-31.

**Files:**
- Modify: OpenCode plugin startup/hooks, Cursor MCP/hook entries, CLI entry, migration/installer boundaries
- Create: `test/workit-opencode/logging.test.ts`, `test/workit-cursor/logging.test.ts`, `test/workit-cursor/mcp-errors.test.ts`

**Interfaces:** Emit named sanitized events for initialization, provenance, assets, configuration source, hooks, MCP connection, migration/install steps, and uncaught failures; MCP domain failures return structured content with `isError: true`.

- [ ] **Step 1: Write failing boundary instrumentation tests**
  Force each boundary to fail with redaction canaries and assert one bounded event, host usability, OpenCode app-log mirroring, Cursor stderr summaries, no MCP stdout contamination, and `isError: true` for domain failures.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-opencode/logging.test.ts test/workit-cursor/logging.test.ts test/workit-cursor/mcp-errors.test.ts`; expected failure is absent events, empty catches, protocol leakage, or successful-looking failures.
- [ ] **Step 3: Add minimum instrumentation**
  Inject the logger at process/adapter boundaries, isolate fail-open detectors, replace empty catches with sanitized rate-limited events, and preserve structured domain details.
- [ ] **Step 4: Run GREEN**
  Re-run focused tests; expected result is complete event coverage with no canary leakage.
- [ ] **Step 5: Refactor only while green**
  Consolidate event names and safe metadata builders without broadening logged content.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(diagnostics): instrument runtime boundaries`.

**Criteria:** Every required startup/failure boundary is diagnosable without persisting prohibited data or corrupting host protocols.

### Task 11: Add shared doctor and installer health enforcement

**Requirements:** DG-07-DG-09, final RR-05/RR-06; CA-04, CA-09, CA-25, CA-28, CA-31.

**Files:**
- Create: `packages/workit-core/src/core/doctor.ts`
- Modify: CLI command registration and both host tool registrations
- Modify: explicit installer/update operations
- Create: `test/workit-core/doctor.test.ts`, `test/workit-cli/doctor.test.ts`, `test/workit-opencode/doctor.test.ts`, `test/workit-cursor/doctor.test.ts`

**Interfaces:** Export `runDoctor(options: DoctorOptions): DoctorReport`, where `DoctorReport` contains typed checks, fixes, summary counts, and `exitCode`; expose `workit doctor`, `workit doctor --json`, and `workflow_doctor` on both hosts.

- [ ] **Step 1: Write failing doctor fixture tests**
  Cover stale pins, mixed versions, missing assets/launchers/runtimes/utilities, duplicate registration, malformed config, workspace mismatch, credential metadata, and unwritable logs without network access.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/doctor.test.ts test/workit-cli/doctor.test.ts test/workit-opencode/doctor.test.ts test/workit-cursor/doctor.test.ts`; expected failure is that known broken fixtures escape or return zero.
- [ ] **Step 3: Implement the shared offline engine and surfaces**
  Reuse package/config/registration primitives, emit specific fixes, keep secrets unread, and invoke doctor after explicit install/update configuration.
- [ ] **Step 4: Run GREEN**
  Re-run doctor tests; expected result is parity across CLI/OpenCode/Cursor and nonzero required failures.
- [ ] **Step 5: Run the Phase 3 gate**
  Run `bun test test/workit-core/logger.test.ts test/workit-core/doctor.test.ts test/workit-cli/doctor.test.ts test/workit-opencode/logging.test.ts test/workit-opencode/doctor.test.ts test/workit-cursor/logging.test.ts test/workit-cursor/mcp-errors.test.ts test/workit-cursor/doctor.test.ts && bun run check`.
- [ ] **Step 6: Record forced-failure evidence and checkpoint**
  Confirm hosts remain usable, no canary reaches logs, and request `wk-commit` with `feat(doctor): verify installation health`.

**Criteria:** One offline engine detects every specified broken installation with actionable fixes and consistent nonzero status.

### Task 12: Replace the wizard with a sequential in-memory state machine

**Requirements:** WZ-01-WZ-03, WZ-07, WZ-11; CA-11, CA-12, CA-31.

**Files:**
- Modify/split: `packages/workit-cli/src/steps.tsx`
- Create: `packages/workit-cli/src/wizard-state.ts`
- Create: `test/workit-cli/wizard-tty.test.tsx`

**Interfaces:** Export `type WizardDraft = { screen: WizardScreen; values: SetupValues; errors: Record<string, string>; cancelled: boolean }` and a pure reducer for Back/Next/Cancel/Apply transitions; mount exactly one Ink input/list control for the active screen.

- [ ] **Step 1: Write failing deterministic TTY tests**
  Assert one control at a time, independent locale/timezone input, current-value detection, Other validation, effective branch-policy display, nonempty custom policy, preserved Back state, Cancel/Escape no-write, and no competing Enter/provider race.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cli/wizard-tty.test.tsx`; expected failure is simultaneous controls, cross-field input, lost state, invalid policy, or premature mutation.
- [ ] **Step 3: Implement the minimum state machine and screens**
  Move all draft transitions to the reducer, render one screen/control, and leave filesystem application for Tasks 13-14.
- [ ] **Step 4: Run GREEN**
  Re-run deterministic TTY tests; expected result is complete focus/navigation behavior green.
- [ ] **Step 5: Refactor only while green**
  Extract reusable screen chrome only after keyboard and focus behavior remains deterministic.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `refactor(cli): add sequential setup wizard`.

**Criteria:** Wizard navigation is deterministic, accessible by keyboard, retains draft state, and writes nothing before Apply.

### Task 13: Make configuration optional, safe, and previewable

**Requirements:** WZ-04-WZ-06, WZ-08, RL-02, RL-06 wizard scope; CA-12, CA-14, CA-22, CA-23, CA-31.

**Files:**
- Modify: `packages/workit-cli/src/logic.ts`, `packages/workit-cli/src/wizard-state.ts`
- Modify: shared config/preset modules in `packages/workit-core/src/core/`
- Create: `test/workit-cli/wizard-config.test.ts`
- Extend: `test/workit-cli/wizard-tty.test.tsx`

**Interfaces:** Produce typed `readSetupState`, `mergePreset`, and `buildSetupPreview`; define `SetupMutation` as a discriminated union of file creation, JSON merge, workspace update, and gitignore append operations; integrations are independent optional draft sections and preview exposes active environment overrides.

- [ ] **Step 1: Write failing config/preview tests**
  Cover private defaults, optional integrations, token preservation, malformed-file blocking, shared preset reset behavior, active overrides, and zero filesystem changes before Apply.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cli/wizard-config.test.ts test/workit-cli/wizard-tty.test.tsx`; expected failure is organization data, overwrite/default fallback, divergent preset values, hidden override, or eager write.
- [ ] **Step 3: Implement typed read/draft/preview behavior**
  Remove private defaults, centralize preset merging, classify missing/malformed state, preserve credentials, and generate exact package/config/workspace/project/gitignore mutations without applying them.
- [ ] **Step 4: Run GREEN**
  Re-run focused tests; expected result is safe optional configuration and exact preview behavior green.
- [ ] **Step 5: Refactor only while green**
  Deduplicate scaffold logic only after byte-preservation and preview assertions remain green.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(cli): preview safe setup mutations`.

**Criteria:** Preview is authoritative, integrations are neutral/optional, malformed state blocks Apply, and no pre-Apply write occurs.

### Task 14: Apply and verify selected platform installations

**Requirements:** WZ-09, WZ-10, WZ-13-WZ-15; CA-08, CA-13, CA-14, CA-31.

**Files:**
- Modify: CLI setup application modules and package-native OpenCode/Cursor registration modules
- Create: `test/workit-cli/platform-install.test.ts`, `test/workit-cli/packed-cli.test.ts`

**Interfaces:** `applySetupPreview(preview: SetupPreview): SetupResult`, where `SetupResult` contains per-platform/per-file `Installed | Configured | Skipped | Failed` entries and an aggregate `exitCode`; selected adapters are configured idempotently and doctor verifies the result.

- [ ] **Step 1: Write failing packed apply tests**
  From an extracted CLI package, assert selected OpenCode/Cursor setup, unrelated config preservation, packaged hygiene availability, file-vs-ignore result distinctions, partial nonzero failure, non-TTY guidance/nonzero, help zero, and `/wk-status` plus doctor completion guidance.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cli/platform-install.test.ts test/workit-cli/packed-cli.test.ts`; expected failure is selected-but-unconfigured hosts, missing assets, replacement of unrelated config, unconditional success, or non-TTY zero exit.
- [ ] **Step 3: Implement minimum Apply and verification behavior**
  Apply only reviewed mutations, use package-native registration/assets, report every result independently, invoke doctor, and propagate partial failures.
- [ ] **Step 4: Run GREEN**
  Re-run focused extracted-package tests; expected result is actual verified host setup and truthful statuses.
- [ ] **Step 5: Refactor only while green**
  Share idempotent merge primitives with doctor/installer code without changing preview output.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(cli): apply selected platform setup`.

**Criteria:** Selected hosts are configured and verified, unrelated state survives, hygiene assets exist, and partial/non-TTY failures are explicit.

### Task 15: Complete workspace UX and deterministic wizard coverage

**Requirements:** WZ-12, WZ-16 and Phase 4 closure; CA-11-CA-14, CA-31.

**Files:**
- Modify: wizard workspace screens/state and setup-preview logic
- Create: `test/workit-cli/workspace-wizard.test.ts`
- Extend: all Phase 4 CLI tests

**Interfaces:** Workspace draft supports current-project setup and add/edit/remove; each accepted pattern has a visible match preview produced by the shared matcher/validator.

- [ ] **Step 1: Write failing workspace and full-navigation tests**
  Cover add/edit/remove, current project, pattern preview, every screen/focus/key path, Back/Cancel/validation, credential preservation, platform installation, and packed `npx` flow.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cli/wizard-tty.test.tsx test/workit-cli/workspace-wizard.test.ts test/workit-cli/packed-cli.test.ts`; expected failure is an uncovered or incorrect navigation/match/apply path.
- [ ] **Step 3: Implement the minimum remaining workspace UX**
  Add only missing reducer/screens/preview behavior and reuse authoritative workspace matching.
- [ ] **Step 4: Run GREEN**
  Re-run focused wizard/workspace/packed tests.
- [ ] **Step 5: Run the Phase 4 gate**
  Run `bun test test/workit-cli/cli-logic.test.ts test/workit-cli/wizard-tty.test.tsx test/workit-cli/wizard-config.test.ts test/workit-cli/workspace-wizard.test.ts test/workit-cli/platform-install.test.ts test/workit-cli/packed-cli.test.ts && bun run check`.
- [ ] **Step 6: Record isolated setup evidence and checkpoint**
  Confirm selected hosts, credentials, unrelated settings, promised assets, and doctor output; request `wk-commit` with `test(cli): cover complete setup workflow`.

**Criteria:** Every setup screen and workspace mutation is deterministically tested, packed setup is truthful, and doctor is green afterward.

### Task 16: Centralize canonical document path safety and preparation

**Requirements:** DC-01-DC-04, DC-14; CA-15, CA-31.

**Files:**
- Create: `packages/workit-core/src/core/docs-layout.ts`
- Modify: `docs-validate.ts`, `sdd.ts`, flow/document tools and both adapters
- Create: `test/workit-core/docs-paths.test.ts`
- Extend: `test/workit-core/docs-layout.test.ts`, `test/workit-core/docs-validate.test.ts`

**Interfaces:** Export one canonical workspace/slug/pair resolver and `prepareDocsLayout`; register `workflow_docs_layout prepare` on both hosts; normalize Cursor's optional root once.

- [ ] **Step 1: Write failing containment and prepare tests**
  Cover missing dirs, absolute/traversal paths, symlink escapes, cross-slug pairs, wrong basenames, arbitrary legacy paths, canonical returned paths, read-only legacy detection, and Cursor/OpenCode root parity.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/docs-paths.test.ts test/workit-core/docs-layout.test.ts test/workit-core/docs-validate.test.ts`; expected failure is duplicated/inconsistent containment or missing prepare behavior.
- [ ] **Step 3: Implement the shared path contract**
  Centralize resolution, create only missing `docs/` and `docs/<slug>/`, return canonical paths, and route existing consumers/adapters through it.
- [ ] **Step 4: Run GREEN**
  Re-run focused tests; expected result is identical safe behavior across all document consumers.
- [ ] **Step 5: Refactor only while green**
  Remove duplicated slug/root helpers only after all existing validation tests remain green.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(docs): centralize canonical layout`.

**Criteria:** Missing canonical directories are prepared safely and every document/flow/SDD consumer enforces one contained path contract.

### Task 17: Implement bounded legacy detection and atomic migration

**Requirements:** DC-05-DC-11; CA-16, CA-17, CA-28, CA-31.

**Files:**
- Create: `packages/workit-core/src/core/docs-migration.ts`
- Modify: both host adapters' native question flow and `workflow_docs_layout migrate`
- Create: `test/workit-core/docs-migration.test.ts`, `test/workit-opencode/docs-migration.test.ts`, `test/workit-cursor/docs-migration.test.ts`

**Interfaces:** `detectLegacyDocs` returns paired/orphaned/ambiguous entries; `migrateLegacyDocs` requires confirmed preflight identity, rescans, copies atomically/no-clobber, and reports rewritten/copied/already-migrated/malformed items.

- [ ] **Step 1: Write failing migration matrix tests**
  Cover explicit-link and filename pairing, bounded `docs/superpowers/`, orphan/ambiguity, exact native choices `Migrate safely` and `Not now`, confirmation/rescan, differing collisions, identical destinations, symlink safety, partial-copy retry, valid copied link/flow rewrites, malformed-state preservation, SDD ignore requirement, decline blocking, idempotency, and byte-identical sources.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/docs-migration.test.ts test/workit-opencode/docs-migration.test.ts test/workit-cursor/docs-migration.test.ts`; expected failure is absent migration behavior or unsafe legacy acceptance.
- [ ] **Step 3: Implement detection and copy-only migration**
  Build the bounded preflight, native question handoff, confirmed rescan, no-clobber staging/copy, allowed copied-file rewrites, malformed reporting, and declined-active-workflow gate.
- [ ] **Step 4: Run GREEN**
  Re-run the full migration matrix; expected result is atomic/recoverable parity on both hosts.
- [ ] **Step 5: Refactor only while green**
  Share filesystem transaction helpers only after collision/idempotency/source-integrity cases remain green.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(docs): migrate legacy workflows safely`.

**Criteria:** Legacy migration is native-choice-driven, copy-only, no-clobber, idempotent, source-preserving, and cannot create divergent active workflows.

### Task 18: Correct SDD creation contracts and host parity

**Requirements:** DC-12-DC-14 and Phase 5 closure; CA-15, CA-16, CA-31.

**Files:**
- Modify: `packages/workit-core/src/core/sdd.ts`, workflow templates, `packages/workit-core/skills/wk-implement/SKILL.md`
- Modify: OpenCode/Cursor SDD adapters
- Test: `test/workit-core/sdd.test.ts`, `test/workit-core/contracts.test.ts`, document migration/parity tests

**Interfaces:** `workflow_sdd_context` creates only `docs/<slug>/sdd/` when implementation starts, returns canonical paths, and leaves `progress.md` absent until the first confirmed append.

- [ ] **Step 1: Write failing SDD contract tests**
  Assert no nested slug, no early/empty progress ledger, canonical host parity, correct workflow-managed wording, and migration refusal until the SDD ignore/management contract is active.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/sdd.test.ts test/workit-core/contracts.test.ts test/workit-opencode/docs-migration.test.ts test/workit-cursor/docs-migration.test.ts`; expected failure is false/nested/early SDD behavior or host divergence.
- [ ] **Step 3: Implement the minimum contract correction**
  Route SDD through canonical layout, delay task/progress artifacts until implementation/first write, and correct every shipped contract path/statement.
- [ ] **Step 4: Run GREEN**
  Re-run focused SDD/contract/adapter tests.
- [ ] **Step 5: Run the Phase 5 gate**
  Run `bun test test/workit-core/docs-paths.test.ts test/workit-core/docs-layout.test.ts test/workit-core/docs-migration.test.ts test/workit-core/docs-validate.test.ts test/workit-core/sdd.test.ts test/workit-core/contracts.test.ts test/workit-opencode/docs-migration.test.ts test/workit-cursor/docs-migration.test.ts && bun run check`.
- [ ] **Step 6: Record source-integrity evidence and checkpoint**
  Confirm missing/traversal/symlink/collision/ambiguity/orphan/idempotency/retry/rewrite/malformed cases and request `wk-commit` with `fix(sdd): enforce canonical working state`.

**Criteria:** SDD state exists only at the canonical location when needed, no empty ledger is created, and both hosts enforce identical contracts.

### Task 19: Capture flow activation and native approval evidence

**Requirements:** FG-01-FG-04, FG-09; CA-18, CA-19, CA-28, CA-31.

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`, flow/document tools
- Modify: OpenCode and Cursor question-result adapters/hooks
- Create: `test/workit-core/flow-enforcement.test.ts`, `test/workit-opencode/flow-enforcement.test.ts`, `test/workit-cursor/flow-enforcement.test.ts`

**Interfaces:** Flow preparation records canonical paths and activation; transitions accept `NativeChoiceEvidence` containing host, question identifier, exact selected label, and recorded timestamp, not bare booleans; mutation guards return one shared transition matrix/error shape.

- [ ] **Step 1: Write failing activation/evidence/bypass tests**
  Assert preparation activation, blocked plan writes before spec approval, blocked product mutation before spec/plan/docs/menu gates, rejected fabricated booleans, accepted exact question results, corrupt/missing state errors, and OpenCode/Cursor parity.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-cursor/flow-enforcement.test.ts`; expected failure is bypassable writes or fabricated confirmation acceptance.
- [ ] **Step 3: Implement the authoritative flow evidence model**
  Persist activation/canonical paths through the workflow-managed flow store, derive transitions from native results, validate state strictly, and expose shared guards to both hosts.
- [ ] **Step 4: Run GREEN**
  Re-run focused flow tests; expected result is identical deterministic gate behavior.
- [ ] **Step 5: Refactor only while green**
  Consolidate transition errors/evidence verification without weakening host-native provenance.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `feat(flow): enforce native approval evidence`.

**Criteria:** Historical Phase 6 transition tests pass. Independent audit later proved the evidence object itself caller-forgeable; Task 30 supersedes the native-attestation claim.

### Task 20: Enforce coordinator boundaries, host workspace, and concurrent state

**Requirements:** FG-05-FG-09; CA-20, CA-21, CA-28, CA-31.

**Files:**
- Modify: core flow store/guards and OpenCode/Cursor mutation hooks
- Create: `test/workit-core/flow-concurrency.test.ts`
- Extend: host enforcement tests

**Interfaces:** `MutationContext` identifies host workspace, coordinator/delegated role, session, and authenticated task identity; active discovery receives that workspace; state writes use unique temporary files plus compare/retry against the previously read version.

- [ ] **Step 1: Write failing coordinator/workspace/concurrency tests**
  Cover coordinator product edits after subagent-driven selection, allowed delegated workers, unrelated `process.cwd()`, unique temp paths, stale concurrent writers, recovery reminders, and the original failed-session fixture.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/flow-concurrency.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-cursor/flow-enforcement.test.ts`; expected failure is coordinator bypass, wrong-root discovery, shared `.tmp`, or lost update.
- [ ] **Step 3: Implement minimum interception and compare/retry**
  Pass host workspace/context explicitly, block coordinator mutations, allow authenticated workers, and atomically compare/retry flow writes with unique temporary names.
- [ ] **Step 4: Run GREEN**
  Re-run focused concurrency/host tests.
- [ ] **Step 5: Run the Phase 6 gate**
  Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-cursor/flow-enforcement.test.ts && bun run check`.
- [ ] **Step 6: Record bypass/recovery evidence and checkpoint**
  Confirm broken-plugin failure and healthy spec/plan/menu sequences; request `wk-commit` with `feat(flow): enforce coordinator boundaries`.

**Criteria:** Historical Phase 6 state/workspace/concurrency tests pass. Task 30 supersedes caller-supplied delegated identity and direct-edit enforcement claims.

### Task 21: Make configuration parsing and preset behavior authoritative

**Requirements:** RL-01, RL-02, RL-06, RL-07; CA-22, CA-23, CA-31.

**Files:**
- Modify: `packages/workit-core/src/core/config.ts`, `config-guard.ts`, `vcs-config.ts`, `workspaces.ts`
- Modify: CLI config reader/preview and Cursor/OpenCode config adapters
- Test: `test/workit-core/config.test.ts`, `config-guard.test.ts`, `config-dir.test.ts`, `workspaces.test.ts`, `test/workit-cli/wizard-config.test.ts`

**Interfaces:** Typed readers distinguish missing/valid/malformed with path-specific diagnostics; one preset merge helper resets all derived fields; previews expose active environment overrides; migration cache has a tested process-boundary contract.

- [ ] **Step 1: Write failing typed-config and preset tests**
  Cover malformed global/workspace/VCS JSON, no overwrite/default, preset switching across all consumers, visible overrides, and config migration cache changes within/across process boundaries.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/config.test.ts test/workit-core/config-guard.test.ts test/workit-core/config-dir.test.ts test/workit-core/workspaces.test.ts test/workit-cli/wizard-config.test.ts`; expected failure is silent fallback, inconsistent policy, hidden override, or stale cache behavior.
- [ ] **Step 3: Implement authoritative parsing and merging**
  Return typed diagnostics, centralize preset derivation/reset, route all consumers through it, expose overrides, and correct/cache-bound migration behavior according to the failing contract.
- [ ] **Step 4: Run GREEN**
  Re-run focused config/wizard tests.
- [ ] **Step 5: Refactor only while green**
  Remove duplicated readers/mergers only after missing-versus-malformed behavior remains explicit.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `fix(config): block malformed state consistently`.

**Criteria:** Risky actions stop on malformed config with exact paths, preset values agree everywhere, and environment/cache behavior is explicit and tested.

### Task 22: Correct PR policy, workspace patterns, issue derivation, and updates

**Requirements:** RL-03-RL-05, RL-09; CA-23-CA-25, CA-31.

**Files:**
- Modify: `packages/workit-core/src/core/branch.ts`, `vcs-config.ts`, `workspaces.ts`, `pr-create.ts`
- Modify: PR context/creation adapters, skills, Cursor session-start entry
- Test: `test/workit-core/branch-policy.test.ts`, `workspaces.test.ts`, `workspaces-scripts.test.ts`, `pr-create.test.ts`, `test/workit-cursor/session-start.test.ts`

**Interfaces:** Every PR surface consumes one resolved target branch; workspace writes validate the supported matcher grammar; issue derivation rejects date-like numeric prefixes; session-start performs no network synchronization.

- [ ] **Step 1: Write failing cross-surface policy regressions**
  Cover GitFlow/GitHub Flow/trunk/custom targets across CLI/OpenCode/Cursor/PR context/create, unsupported workspace syntax, native Windows patterns, date-style branches, deliberate numeric issue branches, and zero startup network calls with explicit update failures.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/branch-policy.test.ts test/workit-core/workspaces.test.ts test/workit-core/workspaces-scripts.test.ts test/workit-core/pr-create.test.ts test/workit-cursor/session-start.test.ts`; expected failure is a target mismatch, unsupported syntax acceptance, date closure, or network startup behavior.
- [ ] **Step 3: Implement the minimum shared policy corrections**
  Route all PR surfaces through authoritative config, reject unsupported patterns at write time unless the matcher implements them, tighten numeric issue derivation, and confine updates to explicit install/update operations with reported failures.
- [ ] **Step 4: Run GREEN**
  Re-run focused policy/workspace/PR/hook tests.
- [ ] **Step 5: Run the Phase 7 gate**
  Run `bun test test/workit-core/config.test.ts test/workit-core/config-guard.test.ts test/workit-core/config-dir.test.ts test/workit-core/branch-policy.test.ts test/workit-core/workspaces.test.ts test/workit-core/workspaces-scripts.test.ts test/workit-core/pr-create.test.ts test/workit-cli/wizard-config.test.ts test/workit-cursor/session-start.test.ts && bun run check`.
- [ ] **Step 6: Record policy matrix and checkpoint**
  Record all effective targets/pattern/date cases and request `wk-commit` with `fix(vcs): unify workspace and PR policy`.

**Criteria:** All hosts/tools resolve identical policies, unsupported patterns are explicit, date branches cannot close unrelated issues, and startup is network-free.

### Task 23: Close debt and prove the final release candidate

**Requirements:** RL-08, RL-10, all mandatory audit/marker closure; CA-01, CA-02, CA-04, CA-05, CA-08, CA-26-CA-31.

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, package manifests/support declarations
- Create: `test/release/traceability.test.ts`, `test/release/release-candidate.test.ts`
- Modify: all resolved/retained `ponytail:` comments and release verification scripts
- Evidence: `docs/workit-reliability-overhaul/sdd/progress.md`

**Interfaces:** `verify:release-candidate` packs, installs, and tests every artifact/host matrix entry from unrelated directories; traceability checks map every audit row, CA criterion, and current marker to passing evidence or an accepted owner/trigger.

- [ ] **Step 1: Write failing traceability and release-proof tests**
  Assert every audit/CA row and current marker maps to a runnable check, resolved markers are absent, retained markers name ceiling/trigger/owner, token auth retains the trusted-publisher trigger, SDK contract versions are pinned/tested, and packed CLI/OpenCode/Cursor MCP/hook/generic MCP entries pass the declared OS/Node/OpenCode matrix.
- [ ] **Step 2: Run RED**
  Run `bun test test/release/traceability.test.ts test/release/release-candidate.test.ts`; expected failure is unmapped debt, stale markers, absent matrix evidence, monorepo dependency, missing rollback artifact, or doctor failure.
- [ ] **Step 3: Implement only remaining release-proof closure**
  Remove resolved markers, rewrite retained markers, add missing matrix/SDK checks, assemble rollback packages/checksums, and keep token auth until every package has a verified trusted publisher.
- [ ] **Step 4: Run GREEN**
  Re-run traceability/release tests from extracted artifacts and unrelated directories; expected result is complete mapped evidence and clean doctors.
- [ ] **Step 5: Run the Phase 8/final gate**
  Run `bun run verify:release-candidate && bun run check`; require Linux/macOS/Windows, declared Node versions, minimum/current OpenCode, Cursor MCP/hook, generic MCP, clean OpenCode/Cursor doctor, and rollback-artifact checks green.
- [ ] **Step 6: Review without publishing**
  Verify no command created a package release, tag, registry publication, or marketplace publication; run final code review and `workflow_docs_validate` on the linked documents.
- [ ] **Step 7: Checkpoint the release-ready branch**
  Request `wk-commit` with `test(release): prove the Workit release candidate`, then prepare a reviewed PR separately from any publication approval.

**Criteria:** The test-assembled candidate remains reproducible and unpublished. Tasks 24 and 31 supersede final release-orchestration and clean-dependency-closure proof.

### Task 24: Make release orchestration fail before publication

**Requirements:** AR-01, AR-02; CA-33, CA-44.

**Files:**
- Modify: `package.json`, `.github/workflows/release.yml`, `release.config.cjs`
- Modify: `packages/workit-opencode/package.json`, `packages/workit-cursor/package.json`, `packages/workit-cli/package.json`
- Test: `test/artifacts/release-orchestration.test.ts`, `test/artifacts/release-candidate.test.ts`, `test/workit-core/rewrite-workspace-deps.test.ts`

**Interfaces:** Root `build` runs the three adapter builds; root `verify:release-candidate` runs the pack-only final artifact gate. Release dependency rewriting executes before npm package verification and after semantic-release assigns versions. Every build, pack, protocol, and dependency check completes before the semantic-release publication step.

- [ ] **Step 1: Write the failing real-workflow regression**
  Assert a clean checkout has no tracked adapter `dist/`, root scripts exist, release workflow order is install → build → candidate verification → semantic-release, and no workspace/dependency assertion appears only after semantic-release.
- [ ] **Step 2: Run RED**
  Run `bun test test/artifacts/release-orchestration.test.ts test/artifacts/release-candidate.test.ts test/workit-core/rewrite-workspace-deps.test.ts`; expected failure is absent root scripts, missing pre-release build/gate, or rewrite verification ordered after npm/release work.
- [ ] **Step 3: Implement minimum release ordering**
  Add root scripts, invoke them before semantic-release, split semantic-release rewrite hooks if necessary so verify-time and prepare-time ordering are both correct, and remove the ineffective post-release-only protocol check.
- [ ] **Step 4: Run GREEN from a clean package sandbox**
  Re-run the RED command after deleting only generated sandbox outputs; expected result is built entries and a passing pack-only candidate without registry, tag, or marketplace operations.
- [ ] **Step 5: Run focused workflow validation**
  Run `bun run build && bun run verify:release-candidate`; expected result is exit 0 with all four local tarballs verified and no publication command.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, review the workflow order, and request `wk-commit` with `fix(release): gate artifacts before publication`.

**Criteria:** A clean checkout cannot reach semantic-release before built artifacts and the release-candidate gate pass; all failure checks are pre-publication.

### Task 25: Close CLI dependencies and exact registration identity

**Requirements:** AR-03, AR-04; CA-34, CA-35.

**Files:**
- Modify: `packages/workit-cli/package.json`, `packages/workit-core/scripts/rewrite-workspace-deps.ts`, `bun.lock`
- Modify: `packages/workit-core/src/core/registration.ts`
- Test: `test/artifacts/release-candidate.test.ts`, `test/workit-cli/packed-cli.test.ts`, `test/workit-core/rewrite-workspace-deps.test.ts`, `test/artifacts/registration.test.ts`

**Interfaces:** The CLI declares `@brainervirus/workit-opencode` and `@brainervirus/workit-cursor` at the same release version. Release rewrite updates every internal `workspace:*` dependency. `isWorkitPlugin(value)` matches only exact package names with optional `@<version>` suffixes and canonical file paths.

- [ ] **Step 1: Write failing clean-dependency and identity tests**
  Install the packed CLI plus only dependencies declared by its packed manifest, run selected OpenCode/Cursor setup, and assert `@brainervirus/workit-opencode-helper` and `@brainervirus/workit-cursor-tools` survive merge unchanged.
- [ ] **Step 2: Run RED**
  Run `bun test test/artifacts/registration.test.ts test/workit-core/rewrite-workspace-deps.test.ts test/workit-cli/packed-cli.test.ts test/artifacts/release-candidate.test.ts`; expected failure is missing adapter discovery or prefix-matched helper removal.
- [ ] **Step 3: Implement minimum dependency closure**
  Declare both adapters in CLI dependencies, rewrite all internal workspace dependencies to the prepared version, tighten identity matching, and regenerate only `bun.lock`.
- [ ] **Step 4: Run GREEN**
  Re-run the RED command; do not manually extract adapter tarballs outside the manifest-driven dependency installer.
- [ ] **Step 5: Verify packed metadata and setup**
  Inspect packed CLI metadata and run the setup flow from an unrelated cwd with repository `node_modules` unavailable; expected result is both selected hosts configured from declared dependencies.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `fix(cli): declare adapter dependency closure`.

**Criteria:** Installing the CLI's declared closure is sufficient for both host setups, and unrelated prefix-sharing packages are preserved.

### Task 26: Make Cursor workspace and entries portable

**Requirements:** AR-05, AR-06; CA-36.

**Files:**
- Modify: `packages/workit-cursor/mcp/server.ts`, `packages/workit-cursor/mcp/run-server.ts`
- Modify: `packages/workit-cursor/hooks/hooks-cursor.json`, `packages/workit-cursor/mcp.json`, `packages/workit-core/src/core/registration.ts`
- Modify: `packages/workit-opencode/scripts/build.ts`, `packages/workit-cursor/scripts/build.ts`, `packages/workit-cli/scripts/build.ts`
- Test: `test/workit-cursor/mcp-process.test.ts`, `test/workit-cursor/mcp-regressions.test.ts`, `test/artifacts/manifests.test.ts`, `test/artifacts/registration.test.ts`

**Interfaces:** `workspaceRootSchema` defaults to `WORKFLOW_WORKSPACE_ROOT` before cwd. Build scripts derive their directory through `fileURLToPath(import.meta.url)`. Cursor manifests use explicit `node` commands and package-relative arguments on every OS.

- [ ] **Step 1: Write failing process and path tests**
  Launch `mcp/run-server.ts <workspace>` from an unrelated cwd, omit `workspace_root` in a tool call, assert the response root equals `<workspace>`, simulate Windows URL/path conversion, and assert MCP/hook commands invoke Node explicitly.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cursor/mcp-process.test.ts test/workit-cursor/mcp-regressions.test.ts test/artifacts/manifests.test.ts test/artifacts/registration.test.ts`; expected failure is cwd leakage, URL pathname misuse, or direct hook execution.
- [ ] **Step 3: Implement minimum portability correction**
  Prefer the launcher environment root, use `fileURLToPath`, and update committed/generated registration entries without adding shell wrappers.
- [ ] **Step 4: Run GREEN**
  Re-run focused tests on the current OS.
- [ ] **Step 5: Run the declared OS matrix**
  Run the package/process jobs on Linux, macOS, and Windows; expected result is identical package-relative workspace and launch behavior.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `fix(cursor): honor workspace and portable entries`.

**Criteria:** Omitted tool roots use the Cursor workspace, and built MCP/hook entries start through Node on all supported OSes.

### Task 27: Fail closed on config shapes and date branches

**Requirements:** AR-07, AR-08; CA-37, CA-38.

**Files:**
- Modify: `packages/workit-core/src/core/config.ts`, `packages/workit-core/src/core/setup-state.ts`, `packages/workit-core/src/core/doctor.ts`, `packages/workit-core/src/core/pr-create.ts`
- Review/modify if affected: `packages/workit-core/src/core/vcs-config.ts`, `packages/workit-core/src/core/workspaces.ts`
- Test: `test/workit-core/config.test.ts`, `test/workit-cli/wizard-config.test.ts`, `test/workit-core/doctor.test.ts`, `test/workit-core/pr-create.test.ts`

**Interfaces:** Object-config readers share the rule `non-null object and not array`; shape errors retain exact paths. Date rejection recognizes a complete year-first or day-first date anywhere in a branch segment before numeric issue extraction.

- [ ] **Step 1: Write failing shape/date tables**
  Cover `null`, strings, numbers, arrays, unreadable files, invalid JSON, `release-2024-01-15`, `v2-2024-01-15-fix`, day-first dates, and deliberate `42-title`/`2024-fix` branches.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/config.test.ts test/workit-cli/wizard-config.test.ts test/workit-core/doctor.test.ts test/workit-core/pr-create.test.ts`; expected failure is default/healthy classification or `Closes #2024` from an embedded date.
- [ ] **Step 3: Implement shared fail-closed semantics**
  Reject non-object shapes consistently and tighten date detection without changing explicit numeric issue behavior.
- [ ] **Step 4: Run GREEN**
  Re-run the RED command and confirm every malformed fixture names its file.
- [ ] **Step 5: Run cross-surface config/PR checks**
  Run `bun test test/workit-core/config-guard.test.ts test/workit-core/config-dir.test.ts test/workit-core/workspaces.test.ts test/workit-core/workspaces-scripts.test.ts`.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `fix(config): reject invalid shapes and date issues`.

**Criteria:** Object-required config never fails open, doctor agrees with readers/setup, and date segments cannot close issues.

### Task 28: Make setup preview authoritative and preserve credential paths

**Requirements:** AR-09, AR-10; CA-39.

**Files:**
- Modify: `packages/workit-core/src/core/setup.ts`, `packages/workit-cli/src/steps.tsx`
- Test: `test/workit-cli/wizard-config.test.ts`, `test/workit-cli/platform-install.test.ts`, `test/workit-cli/packed-cli.test.ts`, `test/workit-cli/workspace-wizard.test.tsx`

**Interfaces:** `SetupPreview.mutations` contains every Apply write, including adapter copy and host registration operations. Credential drafts reuse existing configured token paths; a path replacement is a distinct reviewed mutation. `applySetupPreview` consumes only preview mutations and adds no derived writes.

- [ ] **Step 1: Write failing preview/apply parity tests**
  Snapshot all files before and after Apply, assert every changed path/content class appeared in preview, seed custom YouTrack/GitLab/GitHub token paths with canary bytes, and assert no default token file/config replacement occurs.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-cli/wizard-config.test.ts test/workit-cli/platform-install.test.ts test/workit-cli/packed-cli.test.ts test/workit-cli/workspace-wizard.test.tsx`; expected failure is unpreviewed host writes or custom token path replacement.
- [ ] **Step 3: Implement one mutation model**
  Plan host registration/package-copy operations during preview, resolve existing token paths before drafting config, and make Apply dispatch only the reviewed mutation union.
- [ ] **Step 4: Run GREEN**
  Re-run focused tests and compare preview/apply changed-path sets exactly.
- [ ] **Step 5: Run packed TTY/setup verification**
  Exercise review → Apply from the extracted CLI with selected hosts and custom credentials; expected result is truthful preview, preserved bytes, and idempotent second run.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check` and request `wk-commit` with `fix(init): make preview authoritative`.

**Criteria:** Apply cannot write an unreviewed path and custom credential locations remain authoritative unless replacement is explicitly previewed.

### Task 29: Make doctor and verification output trustworthy

**Requirements:** AR-11, AR-14; CA-40, CA-43.

**Files:**
- Modify: `packages/workit-core/src/core/doctor.ts`
- Modify: negative-path test helpers that currently inherit raw Git stderr
- Test: `test/workit-core/doctor.test.ts`, `test/workit-opencode/doctor.test.ts`, `test/workit-cursor/doctor.test.ts`, `test/workit-cli/doctor.test.ts`

**Interfaces:** Installer doctor has an explicit required-check set containing selected-host runtime, assets, launcher, registration, malformed config, and required utility checks. Optional parity checks may warn. Expected negative subprocess stderr is captured and asserted rather than inherited by the full suite.

- [ ] **Step 1: Write failing installer-health fixtures**
  Remove each selected-host asset/launcher/runtime/registration/utility independently and assert installer report `ok: false`, nonzero exit, and a specific fix. Add a full-check subprocess assertion that repeated raw Git usage/fatal text is absent.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/doctor.test.ts test/workit-opencode/doctor.test.ts test/workit-cursor/doctor.test.ts test/workit-cli/doctor.test.ts`; expected failure is a required check downgraded to warning or noisy inherited stderr.
- [ ] **Step 3: Implement minimum severity/output fixes**
  Correct installer-required classification and capture expected negative Git stderr at the fixture boundary without suppressing unexpected failures.
- [ ] **Step 4: Run GREEN**
  Re-run doctor tests and the focused noisy fixture files; expected output contains assertions, not raw Git help dumps.
- [ ] **Step 5: Run a fresh full check and inspect output**
  Run `bun run check`; require zero failures and no repeated raw Git usage/fatal dumps.
- [ ] **Step 6: Checkpoint**
  Review severity changes and request `wk-commit` with `fix(doctor): fail incomplete installs clearly`.

**Criteria:** Required installation defects are nonzero failures and successful verification output remains readable without hiding unexpected errors.

### Task 30: Replace self-certified flow security with host capabilities

**Requirements:** AR-12, AR-13; corrected FG-04, FG-05, FG-09; CA-18-CA-20, CA-41, CA-42.

**Files:**
- Modify: `packages/workit-core/src/core/flow-state.ts`
- Modify: `packages/workit-opencode/src/plugin.ts`, `packages/workit-opencode/src/tools/flow.ts`, OpenCode tool assembly/state
- Modify: `packages/workit-cursor/mcp/server.ts`, `packages/workit-cursor/mcp/flow-evidence.ts`
- Modify: shipped flow contracts under `packages/workit-core/templates/`, adapter `assets/templates/`, Cursor rules, and relevant skills
- Test: `test/workit-core/flow-enforcement.test.ts`, `test/workit-core/flow-concurrency.test.ts`, `test/workit-opencode/flow-enforcement.test.ts`, `test/workit-opencode/plugin.test.ts`, `test/workit-cursor/flow-enforcement.test.ts`, `test/workit-core/contracts.test.ts`

**Interfaces:** OpenCode observes `question` through `tool.execute.before/after`, stores a one-use receipt bound to `sessionID`, `callID`, exact selected label, and timestamp, and consumes it inside approval/menu tools whose schemas expose no evidence object. OpenCode derives delegated status from `client.session.get({ sessionID }).data.parentID`; caller role fields are removed. While subagent-driven is active, known write tools and coordinator shell mutations are denied, with a bounded read/test/review command allowlist. Cursor records `{ host: "cursor", attested: false, confirmation: "contract" }`, exposes no delegated role, and rejects subagent-driven mutation with recovery guidance.

- [ ] **Step 1: Write failing forgery/replay/identity/interception tests**
  Reproduce invented evidence, replay, wrong session/label, caller `role: delegated`, root-session edit/write/apply-patch, coordinator mutating shell, real question receipt, real child session, Cursor unauthenticated provenance, and Cursor unsupported subagent-driven behavior.
- [ ] **Step 2: Run RED**
  Run `bun test test/workit-core/flow-enforcement.test.ts test/workit-core/flow-concurrency.test.ts test/workit-opencode/flow-enforcement.test.ts test/workit-opencode/plugin.test.ts test/workit-cursor/flow-enforcement.test.ts test/workit-core/contracts.test.ts`; expected failure is accepted fabricated evidence/identity or missing host limitation reporting.
- [ ] **Step 3: Implement OpenCode host-derived trust**
  Add the in-memory receipt lifecycle and host session-parent lookup, remove evidence/role/taskIdentity tool arguments, and enforce coordinator write/shell interception through plugin hooks.
- [ ] **Step 4: Implement the honest Cursor boundary**
  Replace fake native attestation with explicit `attested: false` confirmation provenance, remove delegated-role inputs, block unsupported subagent-driven mutation, and align contracts/docs with the chosen capability boundary.
- [ ] **Step 5: Run GREEN and adversarial process checks**
  Re-run the RED command plus real OpenCode tool-hook and Cursor stdio sequences; require every forged/replayed/root-session attempt to fail and valid supported paths to pass.
- [ ] **Step 6: Run the task gate and checkpoint**
  Run `bun run check`, review the trust-boundary diff separately, and request `wk-commit` with `fix(flow): derive trust from host capabilities`.

**Criteria:** OpenCode no longer trusts model-created evidence or roles; Cursor reports its policy-only boundary honestly and cannot self-certify delegation.

### Task 31: Prove remediation and reconcile the branch

**Requirements:** AR-15 and all Phase 9 closure; CA-44, CA-45.

**Files:**
- Modify: `test/artifacts/release-candidate.test.ts`, `test/artifacts/reliability-report.test.ts`, traceability tests if needed
- Update through registered SDD tools: `docs/workit-reliability-overhaul/sdd/progress.md`, task report/review artifacts
- Validate: `docs/workit-reliability-overhaul/spec.md`, `docs/workit-reliability-overhaul/plan.md`

**Interfaces:** Final evidence maps POST-01-POST-15, AR-01-AR-15, and CA-33-CA-45 to runnable checks. Branch reconciliation uses `workflow_resolve_branch` and confirmed in-place `workflow_branch_setup`; no worktree, force push, publication, or destructive reset is allowed.

- [ ] **Step 1: Write the failing Phase 9 traceability gate**
  Assert every post-audit row maps to an exact test/command and fails if any item is prose-only, any package is manually injected outside declared dependencies, or release ordering is not exercised.
- [ ] **Step 2: Run RED**
  Run the focused traceability/release gate; expected failure names every still-unmapped POST/AR/CA item.
- [ ] **Step 3: Close evidence gaps only**
  Add missing process/matrix/report assertions without changing behavior already proven by Tasks 24-30.
- [ ] **Step 4: Run final GREEN verification**
  Run `bun run build && bun run verify:release-candidate && bun run check`, Linux/macOS/Windows package jobs, clean CLI dependency install/setup, OpenCode host flow adversarial checks, Cursor provenance checks, and doctor fixtures. Record exact counts/checksums and `not published`.
- [ ] **Step 5: Validate documents and SDD state**
  Run `workflow_docs_validate`, `workflow_plan_tasks`, `workflow_sdd_context`, and `workflow_git_context`; require 31 sequential tasks, canonical linked paths/branch, tracked SDD directory, and no hard finding.
- [ ] **Step 6: Reconcile with current main non-destructively**
  Resolve and select the declared branch with `workflow_resolve_branch` plus confirmed in-place `workflow_branch_setup`, preview any dirty-tree handling through native `question`, fetch the configured remote, and merge current `main` with non-interactive `git merge --no-edit origin/main`. Confirm `git merge-base origin/main HEAD` equals `git rev-parse origin/main`, then re-run Step 4; never use a worktree, rebase, force push, or destructive reset.
- [ ] **Step 7: Final review and checkpoint**
  Review `origin/main...HEAD` for only intended overhaul/remediation changes, request a reviewed `wk-commit` for final evidence if files changed, and prepare a PR separately. Do not publish.

**Criteria:** Every post-audit finding has fresh RED/GREEN evidence, all final gates pass after current-main reconciliation, the diff is clean, and no release or force push occurs.

## Task Status

| Status | Task |
| --- | --- |
| complete | 1: Close the restarted OpenCode recovery gate |
| complete | 2: Correct release metadata and Cursor initialization |
| complete | 3: Stop installer, wizard, and credential false success |
| complete | 4: Pack and gate the Phase 0 corrective candidate |
| complete | 5: Establish strict TypeScript and host-neutral boundaries |
| complete | 6: Port maintained shell behavior to shared TypeScript |
| complete | 7: Build self-contained adapters and deterministic assets |
| complete | 8: Correct registration, manifests, pins, and the platform matrix |
| complete | 9: Implement the secret-safe structured logger |
| complete | 10: Instrument runtime boundaries and MCP domain failures |
| complete | 11: Add shared doctor and installer health enforcement |
| complete | 12: Replace the wizard with a sequential in-memory state machine |
| complete | 13: Make configuration optional, safe, and previewable |
| complete | 14: Apply and verify selected platform installations |
| complete | 15: Complete workspace UX and deterministic wizard coverage |
| complete | 16: Centralize canonical document path safety and preparation |
| complete | 17: Implement bounded legacy detection and atomic migration |
| complete | 18: Correct SDD creation contracts and host parity |
| complete | 19: Capture flow activation and native approval evidence |
| complete | 20: Enforce coordinator boundaries, host workspace, and concurrent state |
| complete | 21: Make configuration parsing and preset behavior authoritative |
| complete | 22: Correct PR policy, workspace patterns, issue derivation, and updates |
| complete | 23: Close debt and prove the initial release candidate |
| pending | 24: Make release orchestration fail before publication |
| pending | 25: Close CLI dependencies and exact registration identity |
| pending | 26: Make Cursor workspace and entries portable |
| pending | 27: Fail closed on config shapes and date branches |
| pending | 28: Make setup preview authoritative and preserve credential paths |
| pending | 29: Make doctor and verification output trustworthy |
| pending | 30: Replace self-certified flow security with host capabilities |
| pending | 31: Prove remediation and reconcile the branch |
