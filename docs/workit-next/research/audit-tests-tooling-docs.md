# Audit: tests, tooling, CI, docs (workit 2.1.0, 2026-10-03)

Method: ran every check, scripted counts over test/, skimmed ~40 test files (all large ones plus every artifacts/, codex/, cursor/, mcp/ file header), read all workflows/templates/release config. Percentages are estimates from sampling, not exhaustive review.

## 1. Test suite

### Counts
| Area | Files | Tests (approx) | LOC |
|---|---|---|---|
| workit-core | 82 | ~700 | 31,055 |
| workit-cli | 13 | ~190 | 8,139 |
| workit-opencode | 11 | ~170 | 4,526 |
| artifacts (packed/release/manifests) | 12 | ~150 | 3,856 |
| workit-pi | 5 | ~90 | 3,178 |
| opencode-v2 | 5 | ~80 | 2,408 |
| workit-codex | 3 | ~40 | 1,018 |
| workit-cursor | 5 | ~35 | 663 |
| workit-mcp | 2 | ~25 | 575 |
| acceptance | 1 | ~10 | 339 |
Total: 139 files, 1,572 tests (bun's count), 8,350 expects, ~56k LOC of test vs ~40k LOC of src (tests larger than the code). Only 7 mock/spyOn uses across the suite: tests use real tmp dirs, real git and spawned processes (good: few mock-returns-asserted tautologies). 473 spawn call sites; 1,090 `toContain` calls (of 5.7k expects).

### Runtime
`bun test` full run: 102-113 s wall (no per-file timing in bun; individual tests are mostly <200 ms, the cost is spawn/pack/install tests). Slowest observed: `isolated npm install of the packed CLI ... EBADENGINE` 3.4 s, install-flow tests 1.0-1.2 s (packed-cli, runInit apply), Cursor packed doctor 0.9 s. CI uses `--timeout 5000` (15000 on Windows) for core only.

### Result today: 35 FAIL / 1537 pass, all environmental
Shell node is v22.19.0, but `.node-version`, CI and `SUPPORT_MATRIX.node.current` require 24.20.0. Failures: `test/workit-pi/stock-pi.test.ts:15` and `extension.test.ts:115` (exact `v24.20.0`), plus ~30 setup/doctor/packed-cli tests whose doctor reports "runtime: node 24+ required (found v22.19.0)" (test/workit-cli/packed-cli, platform-install, workit-core/doctor, opencode-setup-pin, artifacts/reliability-report, cursor-install-invariants...). Not a code regression, but: (a) tests hard-fail instead of skipping/pointing to the mismatch, (b) tests assert the host's real `node` equals an exact patch version (`stock-pi.test.ts:12-15` is an environment probe, not a unit test; patch bumps break it).

### Classification (sampled)
- Behavioral/valuable (~75-80%): task-engine, authority, external-action (112 spawn sites, 2.5k LOC), workers, task-hooks (opencode/cursor/pi), safe-write, branch-policy-*, policy-gates, config-guard, vcs-token-scope, route-denial-parity, auto-approval-parity, mcp server/process, wizard-tty. Real fs/git, negative/fail-closed cases (e.g. `workit-cursor/task-hooks.test.ts:153` malformed blocking input exits fail-closed).
- Tautological / copy-equality (~6%):
  - `workit-core/methods.test.ts:310-321` "host skill copies stay byte-identical to every canonical core skill" (14 skills x 4 hosts) and `artifacts/package-contents.test.ts:407` "tracked CLI template mirrors stay byte-identical". These test a copy step; the fix is to remove the copies (build-time vendoring) not to test them.
  - `workit-core/methods.test.ts:344` and `workit-codex/plugin.test.ts:9-30` and `workit-pi/extension.test.ts:166` and `artifacts/package-contents.test.ts:75` each re-list the same fourteen skill names (a 4-5x duplicated constant; adding a skill needs 5 edits and proves nothing).
  - `workit-cursor/runtime-parity.test.ts:12` (12 lines: existsSync + file doesn't contain "zod"), `workit-codex/plugin.test.ts` manifest-shape equality (`capabilities toEqual ["MCP","Task continuity"]`) restate the JSON.
  - `workit-opencode/schema-depth.test.ts` + `workit-core/operation-schemas.test.ts` both re-implement a depth walker for the same constant.
- Brittle exact-prose (~4%): `methods.test.ts:174-184` asserts 10 literal sentences of the bootstrap text ("Never switch execution paths to evade a denial", "A local-commit endpoint does not imply"); `methods.test.ts:300` `skillText("workit-plan")).toContain("never a prerequisite for implementation")`; `methods.test.ts:303-309` regex negations on SKILL.md prose; `reliability-report.test.ts:57` "counts are exact". 42 long-prose `toContain` in total (methods.test.ts 11, workspace-wizard.test.tsx 11). Prose-in-skill tests are the cheapest to delete and the most likely to fail on wording edits.
- Process-ceremony/meta tests (~5%): `artifacts/phase-9-traceability.test.ts` (485 lines): a table of POST-xx/AR-xx/CA-xx rows -> "test-file::exact test name" strings; fails if a test is renamed or `docs/workit-reliability-overhaul/plan.md` changes; line 16/468 requires the git branch `feature/workit-reliability-overhaul` (stale; CI needs `ref: head_ref` hack just for this). `phase-0-candidate.test.ts` (520 lines) overlaps `release-candidate.test.ts` and `scripts/verify-release-candidate.ts`. Test names carry audit IDs (`AR-09/CA-39`, `WZ-14`, `RR-02/PT-06`) meaningful only against deleted/archived specs.
- Redundant across hosts (~5%): route-denial-scope for opencode (101 L) and pi (95 L) are near-identical pairs ("X blocks only noncompliant literal branch targets" / "X branch policy does not depend on task state") on top of `core/route-denial-parity.test.ts`; task-hooks exists 3x with the same scenarios; `docs-migration.test.ts` exists in both workit-core (751 L) and workit-opencode; `typescript-parity.test.ts` (1,180 L) compares TS ports against "shell behavior they replaced" with fixtures captured from shell scripts that were ported away. A parametrized host-conformance suite (one scenario table x adapter) would replace ~1k lines.
- Estimated low-value total: 15-20% of tests (~250-300), ~12-15% of LOC after dedup, mostly artifacts/ + skills/prose + host-duplicate.

### Gaps (behavior with little/no test)
- workit-cli Ink wizard rendering is tested (wizard-tty), but there is no test of the actual published `bin` under plain Node 24 on Windows/macOS beyond the artifacts matrix.
- CI never runs `test/workit-codex`, `test/workit-mcp`, `test/opencode-v2`, `test/acceptance` (see section 3): ~60 tests unexercised in CI.
- No coverage measurement at all; no property/fuzz tests on the shell-command parser/intent classifier (hooks parse arbitrary shell: the highest-risk parser; only example-based).
- No cross-process concurrency test of the task store beyond example cases (`task-store`, `chain-reservation`): no randomized interleavings.
- No contract test against the real OpenCode/Pi/Cursor binaries (stock-pi is only a node-version probe); host API drift is detected only by type changes.
- Live-evidence "90-run batch" is documented but not automated (acceptance/deterministic only).

## 2. Tooling

| Command | Result | Time |
|---|---|---|
| `bun run lint` (oxlint 1.81, `--deny-warnings`) | pass, silent | ~0.1 s |
| `bun run format:check` (oxfmt 0.66) | pass, 294 files | 0.15 s |
| `bun run knip` (6.35.1) | pass with 4 config hints: redundant entry patterns `src/plugin.ts` (opencode), `src/server.ts` (mcp), `src/core.ts` (core), `scripts/build.ts` (pi) | 1.2 s |
| `bun run typecheck` (tsc 7.0.2 native) | pass | 2.4 s |
Whole static pipeline < 5 s; the test suite is 100x slower than every other gate.

Local pitfall: bun here is 1.3.14 while `packageManager`/CI is bun 1.4.1; node 22 vs required 24.

### Lint config
No `.oxlintrc.json` at all: default `correctness` category only, no plugin selection, no per-glob overrides (tests vs src), the file list is duplicated three times in package.json (lint, lint:fix, format, format:check) and omits `scripts/`, `packages/*/scripts` (except codex), `workit-mcp/scripts`. Probing stricter categories on the current tree: suspicious 97 hits, perf 78, pedantic ~1,031, style 16k (noise). Top hits with `-W suspicious -W perf`: `no-await-in-loop` 70, `unicorn/no-array-sort` 48 (mutating sort), `consistent-function-scoping` 35, `no-shadow` 8, `no-map-spread` 3, `no-extend-native` 2. Recommendation: add `.oxlintrc.json` with categories correctness=error, suspicious+perf=warn then ratchet; enable `typescript` and `unicorn` plugins explicitly; add `--type-aware` via `oxlint-tsgolint` (7.0.x; requires tsgolint binary; catches `no-floating-promises`, `no-misused-promises`, `await-thenable`: most valuable for an async-heavy tool/hook codebase with spawn calls); use `ignorePatterns` instead of listing directories.

### oxfmt
Fine. Move the path list into `.oxfmtrc.json` (`ignorePatterns`) so lint/format/knip share one source; `oxfmt` 0.71 available.

### knip config quality
Reasonable but heavy and partially redundant: hints list four redundant entries; 6 `ignoreUnresolved` entries for `scripts/build.ts` duplicated at root and per workspace (root list pre-dates the workspace ones); knip's own bun/semantic-release/package.json-bin plugins already discover entries so many `entry` globs can go (`src/*.ts` in cli entry marks every file an entry, defeating unused-export detection there; same for `packages/workit-core` `src/core/*.ts` which makes every core module an entry so unused exports in core are never reported). Recommend: narrow entries to true public barrels, drop `src/core/*.ts` and `src/*.tsx`, add `ignoreExportsUsedInFile`, run `knip --production` in addition (test files excluded) to find test-only exports. `ignoreDependencies` hides `@semantic-release/*` (these are used by release.config.cjs; knip has a semantic-release plugin, should not need ignores) and `@earendil-works/pi-coding-agent`.

### Candidate additions
- Coverage: `bun test --coverage` works (lcov reporter supported, `coverageThreshold` in bunfig). Run in CI on ubuntu only for core as a visibility metric, no hard threshold at first. Cost: small.
- Mutation testing: Stryker 10.0 has no first-class Bun runner (use its `command` runner wrapping `bun test`, slow, ~100 s per full run x mutants => impractical for the whole repo). Practical option: scope Stryker (command runner, `--incremental`) to 3-4 pure core modules (policy-resolver, task-engine reducer, branch-policy, shell intent parser), weekly job, not PR gate. Worth it only after culling tautological tests.
- Boundaries: dependency-cruiser (or knip + a simple `host-boundaries.test.ts`, which already exists in workit-core) to enforce core must not import hosts, adapters must not import each other; dependency-cruiser is the better fit (declarative rules, fast). madge only finds cycles; use dependency-cruiser with `no-circular` too.
- Package validity: `publint` + `@arethetypeswrong/cli` (attw) on the packed tarballs in the existing `candidate` job (7 packages; packages ship TS-source `exports` for opencode, so attw is relevant only for core/mcp/cli declarations).
- actionlint: yes, run in CI (single Go binary, ~1 s) and locally; also add `zizmor` for workflow security (pinned SHAs, token perms).
- Hooks: lefthook (single binary, parallel, no node dependency, matches the Bun monorepo) with pre-commit = oxfmt/oxlint on staged files; pre-push = typecheck + knip. husky is slower and adds shell shims.
- commitlint: release is semantic-release driven by Conventional Commits and `analyze-release-scope.ts` computes bump, so a bad commit message silently changes release behavior: add commitlint (conventional config) as lefthook `commit-msg` + CI PR-title check (`amannn/action-semantic-pull-request`).
- Deps: Renovate or Dependabot absent. 15 exact-pinned deps are behind (see section 5); add Renovate with grouped npm updates since versions are exact-pinned.

### Recommended fast pipeline
1. Local pre-commit (<1 s): oxfmt --check staged, oxlint staged (lefthook).
2. Local/PR "fast" job (<10 s): lint (with types) + format + knip + typecheck + actionlint + dependency-cruiser. All run in parallel in one job; install once.
3. Unit tier (`bun test test/workit-core test/workit-mcp test/workit-cursor ...` minus spawn-heavy): run sharded (`bun test --shard`) in one ubuntu job with one build; unify typecheck out of every package job (currently repeated 5x).
4. Heavy tier (packed/artifact/candidate/opencode-v2/acceptance) on ubuntu always, macOS/Windows only for core + artifacts (already) and nightly for the full matrix.
5. Weekly: Stryker on scoped modules, `bun outdated` report, live-host acceptance.
Make `bun run check` actually be the CI command (see 3); put the file list in config.

## 3. CI and release

`.github/workflows/ci.yml`: 9 jobs (core x 3 OS, opencode, cursor, cli, pi, shared, artifacts x 3 OS, candidate, react-doctor, knip). Strengths: frozen lockfile, concurrency cancel, least-privilege `permissions: contents: read`, matrix on packed artifacts, explicit Node 24.20.0.
Gaps:
- Tests for `workit-codex`, `workit-mcp`, `opencode-v2`, `acceptance` are in no job (acceptance is only a script). Verify: jobs run `test/workit-core`, `test/workit-opencode`, `test/workit-cursor`, `test/workit-cli`, `test/workit-pi`, `test/artifacts`, `phase-0-candidate` only. A top-level `bun test` never runs in CI, so adding a new test directory silently escapes CI.
- `typecheck` runs in 5 jobs; `lint`/`format:check` run only inside the job named `shared`, whose comment says it's about helpers (stale rationale). `bun run build` is repeated in 4 jobs (no artifact reuse/caching).
- Actions are tag-pinned (`actions/checkout@v7`, `setup-bun@v2`), not SHA-pinned; no bun cache (`setup-bun` + `actions/cache` on `~/.bun/install/cache`).
- `react-doctor` runs `npx -y react-doctor@latest` (unpinned, network, nondeterministic gate, no checkout of lockfile install) for 1 package.
- `artifacts` job checks out `ref: ${{ github.head_ref }}` (empty on push, falls back) purely to satisfy the stale phase-9 branch test (see 1).
- Two dispatch-only diagnostic workflows left in tree: `sync-token-probe.yml` ("Delete once the token is stable") and `windows-inner-suite-probe.yml` which runs `test/workit-core/handoff.test.ts` and `sdd.test.ts` that no longer exist (obsolete, would fail).
- release.yml: build + `verify:release-candidate` gate before semantic-release; `npx semantic-release` (version resolved at run-time, unpinned though `semantic-release` is a devDep: use `bunx`/`bun run`); no provenance (`--provenance`, needs `id-token: write`; comment says OIDC trusted publishing deferred; NPM token long-lived); release is not gated on CI success of the same commit (push to main triggers both independently; `workflow_run`/required status needed); release job has no concurrency group (two quick merges can race on tags).
- Manifest-sync dance (PR created by PAT, auto-merge, cleanup workflow) is a lot of machinery for a version mirror; alternative: drop committed versions (`0.0.0-development` convention) and let `scripts/rewrite-workspace-deps.ts` stamp versions at publish.
- release.config.cjs: well commented; custom path-gated analyze (`analyze-release-scope.ts`), selective publish (`publish-changed-packages.ts`) and 7 bumper npm plugin instances. Comments cite AR-xx ids. Fine functionally; `@semantic-release/commit-analyzer` is replaced by exec, so commitlint is the only protection for message format.
- Templates: `PULL_REQUEST_TEMPLATE.md` is adequate but checks "OpenCode V1/V2, Cursor, Codex, Pi and CLI"; links `docs/<slug>/spec.md`. `ISSUE_TEMPLATE/bug_report.md` is obsolete: lists only OpenCode/Cursor, tools `wk-commit`, `wk-pr`, `workit_verify`, `wk-handoff`, "the workflow-toolkit MCP server" (v0.x names), no Codex/Pi/CLI, no `workit doctor` output field. feature_request.md not reviewed in depth (same vintage). No config.yml, no SECURITY.md, CODEOWNERS, dependabot/renovate.
- CONTRIBUTING.md (1.5 KB, last touched 2026-08-22): says `bun run check` = "bun test + tsc --noEmit" (it now also builds, lints, format-checks) and "CI runs the same command" (false); says semantic-release publishes "`@brainervirus/workit` + `@brainervirus/workit-cli`" (7 packages now); references "the OpenCode review check ... README Code review section" (README has no such section; headings: Install, What it provides, Host surfaces, Configuration and boundaries, Auto-approval, Development, Repository layout); no Node 24/bun 1.4.1 requirement, no test-layout/how-to-add-test guidance, no mention of Cursor/Codex/Pi dev loops.

## 4. Docs classification
(date = last commit touching the file / first added; repo history is only 423 commits and heavily batched, dates are coarse.)

| File | Topic | Date | Status / evidence |
|---|---|---|---|
| README.md (24 KB) | product overview, install, hosts | 10-03 (07-30) | current but long; dev section cites `docs/workit-v1/capabilities.md` (generated 09-30) and a "90-run live batch ... qualification.md"; layout tree omits `scripts/`, `.agents`, `docs/`; consider splitting host sections to package READMEs |
| AGENTS.md (26 KB) | agent contract, host parity table, workflow contract, setup | 10-03 (08-12) | current, but bloated (see below) |
| CONTRIBUTING.md | contributor guide | 08-22 | partially outdated (see 3) |
| CHANGELOG.md (48 KB) | semantic-release generated | 09-30 | current; generated, but header predates 2.x re-baseline: entries reference removed features |
| packages/workit-cli/README.md | CLI wizard | 10-03 | current |
| packages/workit-opencode/README.md | plugin | 09-30 | current-ish (V2 native effects landed 09-30) |
| packages/workit-cursor/README.md (7 KB) | Cursor | 09-13 | partially outdated: predates 09-28 setup/native-effects rework |
| packages/workit-core/README.md | core | 09-12 | probably outdated (predates adaptive-workit) |
| packages/workit-codex / mcp / pi READMEs (1-1.3 KB) | stubs | 09-12/28 | current but thin |
| docs/manifest.json | `{branch: fix/workit-reliability, previous_branch: main}` | untracked (listed in .gitignore as stray branch-setup manifest) | obsolete stray local artifact; delete |
| docs/workit-v1/spec.md (86 KB), plan.md (89 KB), contracts.md (35 KB), qualification.md, task-8-report.md, capabilities.md | Workit 1.0 rewrite design | 09-12 (capabilities 09-30) | superseded by adaptive-workit + opencode-v2; "execution not authorized" status line is stale (v1 shipped). contracts.md "final spec reference" partially still referenced by README (capabilities/qualification) -> keep capabilities.md & qualification.md, archive rest. task-8-report.md obsolete (a one-off task report) |
| docs/workit-reliability-overhaul/spec.md, plan.md (53 KB, 77 KB) | 0.x -> reliability release, AR/CA/RR/PT ids | 08-11 | obsolete/historical, but `test/artifacts/phase-9-traceability.test.ts` reads plan.md; delete test + doc together. Plan itself states Task 30 supersedes earlier claims |
| docs/workit-reliability-delta/spec.md, plan.md, manifest.json | follow-up deltas | 09-16 | superseded by adaptive-workit (`task.close.decisionIds` deprecated) |
| docs/workit-runtime-reliability/spec.md, plan.md | runtime reliability | 09-15 / spec 09-28 | partially outdated; superseded by adaptive-workit/reliability-spec |
| docs/adaptive-workit/spec.md (37 KB), plan.md (48 KB), reliability-spec.md, setup-spec.md | current architecture, native-effects cutover, scoped setup | 09-28..10-03 | current (latest slice; setup-spec status "implemented ... PR/release delivery pending"; README matches #146) |
| docs/opencode-v2/spec.md, plan.md | OpenCode V2 plugin dual-entry | 09-15/09-28 | current for V2 (AGENTS.md matches: "V1 server() + V2 setup()", ten tools); plan.md partially outdated (09-20) |
| docs/auto-approval/spec.md, plan.md | opt-in auto approval | 09-18/09-28 | current (README "Auto-approval (opt-in per workspace)") |
| docs/structural-fixes/spec.md, plan.md | structural audit fixes, session-scoped enforcement | 09-17 | partially outdated ("draft direction"); supersedes route-denial-scope |
| docs/route-denial-scope/spec.md | marker-gate design | 09-17 | superseded by docs/structural-fixes/spec.md (own banner says so). Delete/archive |
| docs/challenge-redesign/spec.md | challenge skill redesign | 09-12 | status unknown; probably implemented (workit-challenge skill present) -> archive |
| docs/deslop-gate/spec.md | deslop gate | 09-12 | probably implemented (workit-deslop skill) -> archive |
| docs/parallel-delegation/proposal.md | parallel delegation | 09-12 | "deferred to 1.1.0 - proposal only" while product is 2.1.0; stale branch `feature/workit-v1` -> decide: implement/delete |
| docs/trackers/spec.md | GitLab/GitHub trackers | 09-12 | "spec only, no implementation", branch `feature/workit-v1`; README/AGENTS now describe per-workspace GitLab/GitHub routing -> likely implemented; archive |
| .superpowers/sdd/ (2 MB: ~90+ review diffs, plan/progress.md) | subagent-driven-dev working state | untracked | obsolete working files (named in .gitignore as "SDD working state (never commit)"); delete locally |
| .workit-evaluation/ (only .gitignore) | evaluation scratch | 09-12 | obsolete/empty |
| .agents/plugins/marketplace.json | Codex marketplace entry | 10-03 | current |
| docs/workit-next/ | this research | today | new |

Docs structure issue: `docs/` has 15 spec/plan folders (~900 KB) of which only 3-4 describe the shipped system; test code and project name conventions (spec.md/plan.md pairs enforced by the product's own `workit_docs_validate`) keep them in place. Recommendation: move superseded ones to `docs/archive/` (or delete; git keeps history), leave `adaptive-workit`, `opencode-v2`, `auto-approval`, `workit-v1/{capabilities,qualification}`.

### AGENTS.md: bloated?
26 KB (~6.5k tokens) loaded into every agent session, 4 sections. The host-parity table (lines 5-30s) has ~300-char cells per row and 9 rows: it duplicates README "Host surfaces" and package READMEs. The "Workflow contract" (line 93+) and "Setup and upgrade maintenance" (line 154+) are maintainer design notes that belong in docs/adaptive-workit. Contains personal config detail (line 147: `work`-glob repos -> GitLab/develop/gitflow, `personal` -> GitHub) that is user-specific policy in a public repo contract. Also history-narration ("existing uncertain history remains inspectable"). Target: <8 KB: build/test/check commands, layout, parity rule, pointers; move tables to docs. No build/test command section exists in it at all (the most useful agent content is missing, e.g. node 24 requirement, `bun run check`).

## 5. Dependencies

`bun outdated` (exact pins; major lines in bold):
| Package | Current | Latest |
|---|---|---|
| @earendil-works/pi-coding-agent | 0.85.1 | **1.0.1** (pi 1.0: needs adapter review) |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.0 |
| @opencode-ai/plugin | 1.18.30 | 1.18.34 (v2 line `@opencode/plugin` pinned 2.0.18 in opencode pkg; not reported) |
| knip | 6.35.1 | 6.39.0 |
| oxlint | 1.81.0 | 1.86.0 |
| oxfmt | 0.66.0 | 0.71.0 |
| typescript | 7.0.2 | 7.0.2 (current) |
| zod (core/mcp/opencode) | 4.5.4 | 4.6.5 |
| ink (cli) | 7.1.1 | **8.0.0** |
| react / @types/react | 19.2.8 / .18 | 19.3.0 |
| @types/node | 24.13.3 | 26.6.4 (keep 24 to match engine) |
| conventional-changelog-conventionalcommits | 8.0.0 | **10.4.0** (check semantic-release 25 compatibility) |
| @semantic-release/npm, github | 13.1.5, 12.0.9 | 13.2.0, 12.0.10 |
| @types/bun | 1.4.1 | 1.4.2 |
Notes: local bun is 1.3.14 vs pinned 1.4.1; `.npmrc`/bunfig sets `minimumReleaseAge = 0` for this checkout (deliberate, documented in bunfig.toml). Effect: not used anywhere (`from "effect"` has zero hits in packages/test/scripts, not a dependency of any package.json). Zod is used for MCP/OpenCode tool schemas (zod 4 `def` introspection in `schema-depth.test.ts` relies on private `_def`/`def` internals: brittle against zod minors).
