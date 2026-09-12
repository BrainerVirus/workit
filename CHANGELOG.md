# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version model.** The repository's package manifests pin a fixed source
> version (`0.4.0`); [semantic-release](https://semantic-release.gitbook.io)
> computes the next version from Conventional Commits and rewrites the package
> versions and internal `workspace:*` dependencies **in CI only**
> (`packages/workit-core/scripts/rewrite-workspace-deps.ts`), never committing
> the rewrite back to the repository. This file is maintained by hand and
> documents through `0.6.0`; releases published after that (for example
> `0.6.1`, `0.7.0`, `0.7.1`) were created by the release workflow and their
> notes live in GitHub Releases, not here. The published npm version can
> therefore run ahead of both the source manifests and this changelog.

## [Unreleased]

### Added

- `wk-*` slash aliases for all fourteen method skills on OpenCode, Cursor,
  and Pi (replacing the five bare aliases); Codex documents `$workit-*`.
- `commitPolicy` config (conventional, gitmoji, ticket-prefix, freeform,
  custom pattern, auto-detect from history) enforced at the `git.commit`
  gate with fail-closed rejections that name the expected flavor.
- Close enforces RED-first ordering on testing requirements: a testing
  requirement with GREEN evidence but no preceding RED failure stays
  unsatisfied, closing the code-then-tests loophole; the behavioral-TDD
  skill text mirrors the rule on all hosts.
- Spec-only docs: GitHub + GitLab issue reads (`docs/trackers/spec.md`,
  read-only title/body/state mirroring YouTrack) and a parallel-delegation
  proposal (`docs/parallel-delegation/proposal.md`, disjoint-scope fan-out
  with single-writer lead mutations — deferred to 1.1.0).
- `context.read` gains `github_issue` and `gitlab_issue` kinds returning the
  same read-only title/body/state triple as YouTrack: GitHub reuses the vcs
  `github.tokenFile` bearer pattern with `gh` issue-ref parsing, GitLab uses
  the vcs `gitlab.tokenFile` `PRIVATE-TOKEN` pattern with full-path project
  resolution (subgroups kept). Both fail closed without a token, the CLI
  wizard offers a GitLab Issues tracker, and Cursor/Codex expose both as MCP
  resources (`workit://context/{kind}`).
- Token files are workspace-tight: a workspace `vcs.tokenFile` wins over the
  global provider file so per-area accounts never collide. Issue reads prefer
  the native CLI (`gh issue view`, `glab issue view`) when installed —
  per-directory identity comes free — and fall back to the workspace-scoped
  token. YouTrack stays token-only (no CLI exists).
- The doctor reports a `github_identity` warning when the checkout's own
  GitHub surfaces disagree (gh CLI login, vcs token-file login, SSH login),
  so operations can never silently land under the wrong account. Only the
  login names are reported, tokens never appear in output, every probe fails
  open, and no accounts are hardcoded — alignment stays in your own git/gh
  configuration.
- `commitPolicy` per-workspace override in `workspaces.json` (workspace wins,
  else global), resolved through `resolveCommitPolicyFor` at the `git.commit`
  gate.
- `workit-challenge` added to the bootstrap moment-based skill routing so
  ambiguous proposals trigger it without an explicit alias call.
- v1 pre-close batch: deterministic spec triage (`triageTier`/`triageSignals`
  with Large/Medium/Small tiers plus recorded override), five bare slash
  aliases (`/challenge`, `/babysit`, `/implement`, `/plan`, `/debug`) on
  OpenCode/Cursor/Pi with `$workit-*` documented for Codex CLI, auto-start
  PR babysitting (`hosting.pull_request` `babysit?` flag, default on) that
  merges per `pr` settings after green, seven new method skills (babysit,
  blast-radius, deslop, diagram, mockup, green-run, steer) with upgrades to
  debug/review/challenge/plan/behavioral-tdd, spec-template tightening
  (Change line, SHALL/GIVEN-WHEN-THEN, skip marker, review checklist),
  `context.read` YouTrack bodies (summary plus description, fail-closed),
  and `scopeCovers` trailing-slash normalization.
- Validation fix program: the CLI documents and implements `workit <family>
<action>` (help, READMEs, contract, pinned help test), `workit writer
acquire --actor <id>` binds a writer to a Codex session the hook matches,
  and `workit_init_apply` is registered on OpenCode with the `branch_policy`
  action. Cutover failures are loud (unknown hosts, malformed resolutions),
  rollback parses flags anywhere, apply honors `--json`, and the uninstall
  picker covers all four hosts. Both hooks share one fail-closed shell parser
  with symlink resolution, the Cursor preToolUse matcher covers the guard set
  with doctor drift detection, and hook attestation no longer claims unsigned
  input.

- The CLI setup wizard now auto-detects installed hosts: detected OpenCode and
  Cursor installs preselect on the platforms screen, existing workit
  registrations are tagged "already configured", and detected Codex/Pi point at
  `workit cutover`. Detection is presence-only (CLI on PATH or home config
  marker, never a subprocess probe) via the shared `detect-hosts` core module.

- Acceptance fixtures, observable-action judge, 90-run evaluation plan, adapter
  capability matrix generator, and stable-release gate for Workit v1 qualification.
  Deterministic CA-31/CA-32 checks run in `verify:release-candidate`; the live
  batch remains behind explicit authorization (`docs/workit-v1/qualification.md`).

- Candidate capture now uses Git's ignore-aware inventory in Git workspaces,
  avoiding recursive scans of ignored dependency and build trees while keeping
  tracked files, relevant untracked files, and staged deletions visible.

- Codex CLI and desktop integration with a native plugin manifest, shared MCP
  transport, documented SessionStart/PreToolUse/subagent hooks, and separate
  CLI/desktop qualification records. Unsupported receipts and writer delegation
  remain explicitly unavailable.

- Optional external-action wrappers now bind concrete host-owned Git, hosting,
  YouTrack, time, and documentation effects to the exact canonical
  operation/target/payload approved by one native action decision, and preserve
  uncertain remote outcomes. OpenCode/Pi use native receipts, the CLI exposes
  an interactive TTY confirmation route, and caller-unattested MCP mutation
  requests remain unavailable.

- Added the read-only `context.read` surface for git/PR/YouTrack/changelog,
  release, and affected context across native adapters and the CLI, plus
  equivalent Cursor/Codex MCP resources. Context reads require no approval or
  writer and do not mutate the checkout or Workit metadata. Release reads now
  include a deterministic Markdown draft; affected reads identify files while
  edits remain existing writer/scope-guarded native actions.

- Pi v1 native extension with the stock package manifest, eight shared
  operation tools, seven canonical method skills, native session/compaction
  continuity, and truthful UI/trust/sandbox capability boundaries. The bundled
  coordinator now supervises fresh stock-Pi reviewer/investigator processes and
  explicitly scoped implementers with observed lifecycle and uncertain
  cancellation boundaries. A child-disabled `workit_worker_control` host
  orchestration tool does not expand the eight shared core families.

- Cursor v1 now uses the shared MCP transport, one documented native hook
  executable, and exactly seven canonical adaptive method skills. AskQuestion,
  session-start/compaction, subagent stop identity, arbitrary shell writes, and
  Tab edits are reported with their actual policy-only or unavailable assurance.

- OpenCode v1 integration now exposes the eight shared Workit operation tools,
  native receipt/lineage hooks, compact task continuity, and only the seven
  policy-selected method skills; the plugin build targets OpenCode 1.18.30.
- Added the shared `@brainervirus/workit-mcp` low-level transport for the eight
  core operation families, with trusted native context boundaries and
  host-specific activation left to the adapter tasks.
- Workit CLI task control over all eight shared operation families and 24
  schema-owned actions, with inline/`@file`/stdin payloads, exact `--json`
  Results, headless consent handling, and read-only `workit handoff --task`
  export plus compact destination context.
- Interactive `workit uninstall` CLI command: a TTY-only host picker (OpenCode/Cursor) with a reviewable action summary before any mutation; it applies the exact inverse of setup's registrations for the selected hosts only — unselected hosts and `~/.config/workit` are preserved byte-for-byte, malformed host files fail untouched, and exit codes are 0 ok / 1 partial failure / 2 non-TTY usage.
- Added an approved reliability-overhaul specification with full requirement, audit, and Ponytail traceability.
- Added pinned Oxlint and Oxfmt checks for first-party TypeScript and package metadata.
- Per-workspace branch policy (`workspaces.json` `branchPolicy`) with git-flow-style detection init and `integration: pr|merge` in the core and the CLI wizard (host init surfaces pending).
- Added a `validate:cursor-marketplace` gate that validates the tracked Cursor Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, skill/rule frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).
- Added verbatim snapshots of the current official Cursor `plugin.json`/`marketplace.json` schemas with retrieval provenance.
- The doctor gained a `stale_install` finding on the Cursor/CLI hosts that detects plugin auto-load rot before it breaks features: legacy `--package=` pins in the plugin's own `mcp.json`, a sessionStart hook running a legacy selector, or a local-dist install behind the current/published runtime all surface with the exact repair step; canonical `@latest` installs never fail on version metadata (the selector resolves fresh at launch), and the sole network probe (the npm registry) fails open as a `registry_unreachable` warning — never a false `stale_install` and never a hard doctor failure.
- The release pipeline now syncs every tracked manifest (root, four platform packages, Cursor plugin manifest) to the released version through an auto-merged PR after each publish, ending the committed-version vs git-tag drift; the root workspace is renamed `workflow-toolkit` → `workit` and pre-aligned to v0.8.9.
- Cursor subagent execution now uses documented native `subagentStart` and bounded product-write hooks. AskQuestion, compaction/session-start continuity, exact subagent stop identity, arbitrary shell writes, and Tab edits remain truthfully marked policy-only, agent-guided, or unavailable where Cursor cannot attest them.

### Changed

- Arbitrary file writes are host-policy on every adapter: the OpenCode,
  Cursor, Codex, and Pi write interceptors no longer gate tools or shell
  commands on task scopes, and the core product-write check keeps only
  writer, role, and session ownership (path-scope enforcement is gone, along
  with the now-dead shell-intent parser). Managed workit mutations (task
  state, external actions, setup/cutover) keep writer ownership; capability
  reports mark `known_product_writes` accordingly.
- Removed path confinement (`trustedPaths`) across core and all four
  adapters plus the CLI wizard: absolute scope paths are valid and only
  traversal escapes are rejected; writer ownership, role, session, scope,
  and approvals remain the bound. The `trustedPaths` wizard screen is gone
  and the setup preview no longer merges it.
- OpenCode's advertised operation schemas now use bounded provider-safe projections for deeply nested inputs while preserving core-owned validation and the complete eight-family tool surface.

- Cancelling a worker that was assigned but never launched no longer leaves the coordinator blocked with no truthful way out. The core gained two host-only methods, `prepareWorkerDispatch` and `commitWorkerDispatch` (no new operation family, no new serialized field, no caller-supplied receipt): a host claims the launch slot of an exactly-`assigned` worker before spawning, and the resulting in-process reservation is settled exactly once — either `started` with the observed child session, or `not_started`, which records a host-attested `stopped` with a null session. OpenCode prepares in `tool.execute.before` for a native `task` call when exactly one assigned worker is attributable to that coordinator and only claims "never started" when that same task call explicitly proves no child session exists; Pi prepares immediately before spawn on the live handle and only settles "never started" while that same handle proves no spawn was attempted. Ambiguous assignments, generic cancellation strings, missing child metadata, and reservations lost to a restart all stay unresolved and are never inferred to be stopped.
- Releases are now path-gated and selectively published: tooling-only merges cut no release, and npm receives only packages whose payload changed since the previous tag. The publisher diffs against the previous release tag passed by semantic-release (`${lastRelease.gitTag}`) — the new release tag is created before publish plugins run, so diffing against the latest tag skipped every package.
- Repository checks now run lint, format verification, tests, and TypeScript typechecking.
- The OpenCode package now bundles the `@opencode-ai/plugin` SDK surface into its build and pins the SDK as a build-only dependency, dropping the unused transitive `ini@7` install path.
- Raised the Node support floor to 24 across the support matrix, package `engines`, CI, and documentation (the current toolchain requires Node ≥ 24).
- The Cursor README now documents Marketplace and local installation, Node/network requirements, MCP/hook runtime execution, Git/VCS/YouTrack/filesystem interactions, persistent redacted logs, secret handling, `@latest` review drift, update behavior, and troubleshooting; CI runs the Marketplace validator in the Cursor and candidate jobs.
- Two-workspace VCS routing: `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow; resolution order is explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The global `vcs.json` `defaultTargetBranch` is removed from the active config and can no longer shadow a matched workspace's branchPolicy default.
- Legacy `~/.config/workflow-toolkit/` non-secret config files (config.json, vcs.json, youtrack.json, workspaces.json, templates/) were cleaned up once the active `~/.config/workit/` config passed status checks; the runtime reads only the active config dir.
- The complete orchestration tool surface was renamed from `workflow_*` to `workit_*` across both host adapters (OpenCode native tools, Cursor MCP registrations), the shared core strings and mutation allowlist, shipped skills/templates/vendor content, and all tracked documentation. Host-only tool names are unchanged by the rename. Legacy brand strings (`workflow-toolkit`, `workflow_toolkit`, `workflow-toolkit-contract`) are unchanged for legacy-identity detection.
- User-facing surfaces were renamed from `workflow-toolkit`/`workflow_toolkit_*` to `workit`/`workit_*`: the bootstrap contract marker is now `<workit-contract>`, `workflow_toolkit_status`/`workflow_toolkit_init_status`/`workflow_toolkit_init_apply` became `workit_status`/`workit_init_status`/`workit_init_apply`, the share path is `~/.local/share/workit`, and the install-root marker is `.workit-root`; legacy-identity detection and migration from the old config directory are unchanged.
- Installs made before the rename carry a stale `.workflow-toolkit-root` install-root marker that the runtime no longer reads (it falls back to environment/dev paths until then); the next sync rewrites the marker to `.workit-root`, so the transition resolves on re-sync.
- `install-cursor-plugin.sh` gained a `--local-dist` mode that registers node-form MCP/hook launchers against the installed plugin's own built `dist/` (instead of the published npx pin), so a checkout install runs the current branch's code — rename included — without waiting for a release; the doctor accepts this local-dist hook alongside the canonical pin.
- The Cursor runtime selector evolved in one step from an exact reviewed pin (`@brainervirus/workit-cursor@0.8.5`, the latest public at the time) to the `@latest` dist-tag with a mandatory `--prefer-online` flag (`npx -y --prefer-online --package=@brainervirus/workit-cursor@latest …`): `--prefer-online` forces fresh registry re-resolution so a stale `latest` in the `_npx` cache is never reused, the doctor enforces this exact launcher shape, the doctor's negative-rejection fixtures cover near-miss variants, and no per-release manual pin bump is required.
- `install-cursor-plugin.sh` now self-heals stale plugin installs: a `doctor-check.ts cursor --stale` pre-check exits 2 on a `stale_install` failure and the installer then refreshes the plugin directory and rewrites the workit MCP/hook entries to the canonical `@latest` + `--prefer-online` selector, preserving unrelated MCP servers; a registry-unreachable comparison stays fail-open (warn, never stale, never install failure), and a healthy install is byte-untouched.
- Delegated authority is direct-child-only: a worker's host `parentID` must equal the activating coordinator's session handle; mismatched or multi-owner lineage fails closed with `delegation_lineage_denied`, nested `opencode` launches are denied during active delegated work, and authorized children receive only compact worker-only context.

### Fixed

- Worker lifecycle observations that change nothing (same state, same
  session, no writer side-effect) no longer rewrite the worker entry or bump
  task revisions. Hosts observe on every session event, so the old
  rewrite-per-event storm invalidated the revision each call returned and
  worker sessions could never chain two calls (e.g. a reviewer could never
  record review evidence). Genuine transitions still mutate.
- The deterministic Ink TTY harness now drains Ink's lone-ESC disambiguation
  timer (~20ms) at every key boundary, so ESC-cancel races in wizard
  back-navigation tests are gone; `burst()` remains for atomic ESC-prefixed
  sequences.
- OpenCode Workit bootstrap and method skills now require `task.start` then
  `policy.assess` when `task.list` is empty, so ordinary product/debug work no
  longer skips Workit because no policy rule was pre-selected.

- Bind spec/plan approvals to exact-byte SHA-256 digests so edited documents invalidate stale approvals and require fresh reapproval; reject recursive handoffs; and restrict subagent-driven reminders and interception to active execution.
- OpenCode development installation now pins the active checkout and removes stale Workit plugin identities.
- The CLI initialization wizard no longer enters an unbounded render loop after an input change — unchanged controlled values now preserve state identity instead of constructing new drafts.
- Routine structured `info` logs no longer leak into the CLI or OpenCode terminal UI — the CLI sinks only `warn`/`error` to stderr and OpenCode uses native app logging, while durable JSONL diagnostics are preserved.
- CLI installation on Node 24.20 no longer reports an `ini@7` engine warning from workit's dependency tree.
- A fresh local Cursor install now uses `~/.cursor/plugins/local/workit` with `enabled_plugins.workit = true`, and migrates exact legacy `workflow-toolkit` entries only after the replacement succeeds.
- Feature branch creation and PR context now honor workspace/global target-branch policy instead of hardcoding `develop`.
- Cursor install rewrites the plugin mcp.json to an absolute path so plugin MCP servers start in any project directory (package-relative shipped manifest unchanged).
- Workspace matching tolerates OS temp-dir symlinks (`/var` → `/private/var` on macOS) so git-derived realpaths and logical config globs still match.
- PR template discovery returns the actual on-disk template name on case-insensitive filesystems (macOS/Windows).
- Doctor and verification runtime detection probes `*.exe` on Windows so installed node/bun/git are found.
- Plugin identity matching normalizes path separators so Windows `file://` pins are recognized.
- Log redaction and documentation-file listing emit portable path forms on Windows (home-prefix `~` and `./`-relative paths).
- npm publish no longer re-builds adapters inside `prepublishOnly` — the release workflow's build + release-candidate gate already verify the artifacts, and the npm lifecycle's node_modules restructuring broke subpath resolution (`@brainervirus/workit-core/src/*`) mid-publish.
- Cursor runtime commands now pin `@brainervirus/workit-cursor@0.8.0` so stale `_npx` dist-tag caches cannot break MCP/session-start startup; the pin is a deliberate reviewed update, bumped only after the target npm version is public, never a mutable `latest` dist-tag.
- GitHub `prCreate` now pushes the branch (`git push -u origin <branch>`) before `gh pr create` when `pr.pushBranch` is enabled (default), returning a structured `push failed` result on failure; `pr.pushBranch: false` disables the push.
- A caller-supplied PR target equal to the resolved workspace default (`main` under github-flow, `develop` under gitflow) is accepted even though protected; genuine differing overrides to protected or disallowed branches are still rejected.
- Menu receipt label matching now tolerates host qualifiers such as `(Recommended)` and `(new session only)`; original label bytes are preserved.
- Windows CI flake: the RL-03 pr-create target test now gets the 60s per-test budget already used by sibling heavy-git tests (Windows git cold starts).
- Branch setup no longer strands the pre-checkout stash when base/checkout resolution fails — the working tree is restored exactly as it was.

## [0.6.0] - 2026-08-10

### Added

- Moved the default configuration directory to `~/.config/workit` with automatic legacy migration.
- Added matching configuration-directory behavior to installer and runtime scripts.

### Fixed

- Made partial configuration migrations retry safely and corrected related documentation and skill paths.

## [0.5.6] - 2026-08-10

### Fixed

- Derived package versions at runtime and synchronized versions during release to prevent stale package URLs and metadata.

## [0.5.5] - 2026-08-10

### Fixed

- Corrected CLI branding, Node.js engine requirements, and README prerequisites.

## [0.5.4] - 2026-08-10

### Fixed

- Published the CLI as a fully self-contained bundle.

## [0.5.3] - 2026-08-09

### Fixed

- Made the Cursor development MCP resolve Workit core from the live monorepo.

## [0.5.2] - 2026-08-09

### Fixed

- Made the CLI bundle runnable with Node.js without a Bun shebang.
- Corrected repository URLs and dynamic version badges across packages.

## [0.5.1] - 2026-08-09

### Fixed

- Granted semantic-release the issue and pull-request permissions required for release comments.

## [0.5.0] - 2026-08-09

### Added

- Split Workit into publishable core, OpenCode, Cursor, and CLI packages.
- Added semantic-release, package verification, and a no-Python architecture gate.

### Changed

- Ported changelog, YouTrack, VCS, initialization, presentation, and PR logic to TypeScript.
- Reorganized tests by package and updated package documentation for the Workit rebrand.

### Fixed

- Hardened npm authentication, release permissions, workspace dependency rewriting, package assets, and development plugin pins.
- Corrected work-date serialization and release-time package metadata.

## [0.4.0] - 2026-08-08

### Added

- Added deterministic validation, branch, PR, handoff, and post-plan workflow gates.
- Vendored Superpowers skills and introduced feature-scoped spec, plan, and SDD document layout.
- Added quality templates, structured spec/plan findings, self-review gates, and implementation coverage checks.
- Added docs-repository linking, listing, validation, and spec promotion.
- Added assisted locale and branch-policy configuration, editable templates, and canonical multi-platform rules.
- Added per-turn contract enforcement, bounded-choice detection, clickable documentation delivery, and SDD ignore enforcement.
- Added project hygiene generation and verification for changelog, README, editor, attributes, license, and contribution files.
- Added open-source package metadata, GitHub templates, Cursor marketplace metadata, and a multi-platform CI matrix.
- Added the interactive `workit` initialization wizard with project and workspace setup.
- Added configuration guards, document-rendering rails, GitHub/YouTrack issue linking, and workspace-aware VCS configuration.
- Added verification, TDD, brainstorming, debugging, review-reception, subagent, and issue enforcement rails.

### Fixed

- Hardened token handling, configuration path resolution, cross-platform paths, glob matching, issue parsing, and wizard focus behavior.

## [0.3.18] - 2026-07-30

### Added

- Added GitHub installation, modern CI/release automation, and Cursor deeplink documentation.
- Added monorepo bootstrap, presentation tools, Cursor support, and runtime auto-sync.

### Fixed

- Restored OpenCode workflow commands through a direct plugin pin and corrected Cursor MCP dependency resolution.

## [0.3.17] - 2026-07-15

### Fixed

- Ensured handoff always stops the originating session.

## [0.3.16] - 2026-07-15

### Fixed

- Created interactive continuation sessions during handoff.

## [0.3.15] - 2026-07-15

### Fixed

- Derived handoff stay mode from the invoked command.

## [0.3.14] - 2026-07-14

### Fixed

- Enforced the no-worktree policy through native permissions and closed guard bypasses.

## [0.3.13] - 2026-07-14

### Added

- Introduced the native OpenCode workflow package, safe runtime core, repository context tools, guarded mutations, SDD orchestration, seeded handoffs, and YouTrack integration.
- Added native workflow UX adapters and full integration coverage.

### Fixed

- Hardened workflow boundaries, repository mutations, changelog roots, branch contracts, handoff selection, runtime safety, and time-log validation.

[Unreleased]: https://github.com/BrainerVirus/workit/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/BrainerVirus/workit/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/BrainerVirus/workit/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/BrainerVirus/workit/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/BrainerVirus/workit/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/BrainerVirus/workit/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/BrainerVirus/workit/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/BrainerVirus/workit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/BrainerVirus/workit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BrainerVirus/workit/compare/v0.3.18...v0.4.0
[0.3.18]: https://github.com/BrainerVirus/workit/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/BrainerVirus/workit/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/BrainerVirus/workit/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/BrainerVirus/workit/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/BrainerVirus/workit/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/BrainerVirus/workit/releases/tag/v0.3.13
