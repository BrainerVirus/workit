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

- Expose plan lifecycle controls (`workit_plan_pause`/`resume`/`complete`) and CLI flow/handoff commands (`workit flow status|pause|resume|complete`, `workit handoff`), including a four-choice handoff-destination contract.
- Added an approved reliability-overhaul specification with full requirement, audit, and Ponytail traceability.
- Added pinned Oxlint and Oxfmt checks for first-party TypeScript and package metadata.
- Per-workspace branch policy (`workspaces.json` `branchPolicy`) with git-flow-style detection init and `integration: pr|merge` on OpenCode, Cursor, and the CLI wizard.
- Added a `validate:cursor-marketplace` gate that validates the tracked Cursor Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, skill/rule frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).
- Added verbatim snapshots of the current official Cursor `plugin.json`/`marketplace.json` schemas with retrieval provenance.
- Added a `workit flow review-package` CLI command that writes the review diff for a `--base..--head` range through the shared-core guard, which rejects empty ranges (`base == head` or a diff that is empty) with a structured error.
- Codified atomic per-task commit ranges in the plan template and execution skills: each SDD task lands exactly one contiguous non-empty commit range, fix rounds append to that range without rewriting an active review range, and each progress line records the task's real `base..head` shas.
- SDD control metadata (flow state, briefs, ledgers, advisories) is coordinator-owned under the gitignored `docs/<slug>/sdd/`; a new `workit_sdd_append_advisory` tool and CLI `workit flow append-advisory --plan <path> --task <id> --text <text> [--confirm]` record advisory review findings in `advisories.md` without an unrestricted file edit.
- The doctor gained a `stale_install` finding on the Cursor/CLI hosts that detects plugin auto-load rot before it breaks features: legacy `--package=` pins in the plugin's own `mcp.json`, a sessionStart hook running a legacy selector, or a local-dist install behind the current/published runtime all surface with the exact repair step; canonical `@latest` installs never fail on version metadata (the selector resolves fresh at launch), and the sole network probe (the npm registry) fails open as a `registry_unreachable` warning — never a false `stale_install` and never a hard doctor failure.
- The release pipeline now syncs every tracked manifest (root, four platform packages, Cursor plugin manifest) to the released version through an auto-merged PR after each publish, ending the committed-version vs git-tag drift; the root workspace is renamed `workflow-toolkit` → `workit` and pre-aligned to v0.8.9.

### Changed

- Releases are now path-gated and selectively published: tooling-only merges cut no release, and npm receives only packages whose payload changed since the previous tag. The publisher diffs against the previous release tag passed by semantic-release (`${lastRelease.gitTag}`) — the new release tag is created before publish plugins run, so diffing against the latest tag skipped every package.
- Repository checks now run lint, format verification, tests, and TypeScript typechecking.
- Spec/plan approval now needs a single confirmation per document; the self-review validation runs automatically during the transition.
- The OpenCode package now bundles the `@opencode-ai/plugin` SDK surface into its build and pins the SDK as a build-only dependency, dropping the unused transitive `ini@7` install path.
- Raised the Node support floor to 22 across the support matrix, package `engines`, CI, and documentation (Ink 7 requires Node ≥ 22).
- The Cursor README now documents Marketplace and local installation, Node/network requirements, MCP/hook runtime execution, Git/VCS/YouTrack/filesystem interactions, persistent redacted logs, secret handling, `@latest` review drift, update behavior, and troubleshooting; CI runs the Marketplace validator in the Cursor and candidate jobs.
- Two-workspace VCS routing: `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow; resolution order is explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The global `vcs.json` `defaultTargetBranch` is removed from the active config and can no longer shadow a matched workspace's branchPolicy default.
- Legacy `~/.config/workflow-toolkit/` non-secret config files (config.json, vcs.json, youtrack.json, workspaces.json, templates/) were cleaned up once the active `~/.config/workit/` config passed status checks; the runtime reads only the active config dir.
- The execution contract now mandates ending every run with `workit_plan_complete` (or the CLI `workit flow complete`) after the final task, once the SDD ledger is complete and repository verification passes — a run never finishes while the plan is still `active`.
- The complete orchestration tool surface was renamed from `workflow_*` to `workit_*` across both host adapters (OpenCode native tools, Cursor MCP registrations), the shared core strings and mutation allowlist, shipped skills/templates/vendor content, and all tracked documentation. Host-only tools keep their host-only names: OpenCode `workit_commit`/`workit_handoff_session`, Cursor `workit_handoff_prompt`. Legacy brand strings (`workflow-toolkit`, `workflow_toolkit`, `workflow-toolkit-contract`) are unchanged for legacy-identity detection.
- `sddReviewPackage` and the SDD progress-line validator now reject empty commit ranges (`base == head` or a diff that is empty) with a structured `empty_commit_range` error instead of writing empty review artifacts.
- User-facing surfaces were renamed from `workflow-toolkit`/`workflow_toolkit_*` to `workit`/`workit_*`: the bootstrap contract marker is now `<workit-contract>`, `workflow_toolkit_status`/`workflow_toolkit_init_status`/`workflow_toolkit_init_apply` became `workit_status`/`workit_init_status`/`workit_init_apply`, the share path is `~/.local/share/workit`, and the install-root marker is `.workit-root`; legacy-identity detection and migration from the old config directory are unchanged.
- Installs made before the rename carry a stale `.workflow-toolkit-root` install-root marker that the runtime no longer reads (it falls back to environment/dev paths until then); the next sync rewrites the marker to `.workit-root`, so the transition resolves on re-sync.
- `install-cursor-plugin.sh` gained a `--local-dist` mode that registers node-form MCP/hook launchers against the installed plugin's own built `dist/` (instead of the published npx pin), so a checkout install runs the current branch's code — rename included — without waiting for a release; the doctor accepts this local-dist hook alongside the canonical pin.
- The Cursor runtime selector evolved in one step from an exact reviewed pin (`@brainervirus/workit-cursor@0.8.5`, the latest public at the time) to the `@latest` dist-tag with a mandatory `--prefer-online` flag (`npx -y --prefer-online --package=@brainervirus/workit-cursor@latest …`): `--prefer-online` forces fresh registry re-resolution so a stale `latest` in the `_npx` cache is never reused, the doctor enforces this exact launcher shape, the doctor's negative-rejection fixtures cover near-miss variants, and no per-release manual pin bump is required.
- `install-cursor-plugin.sh` now self-heals stale plugin installs: a `doctor-check.ts cursor --stale` pre-check exits 2 on a `stale_install` failure and the installer then refreshes the plugin directory and rewrites the workit MCP/hook entries to the canonical `@latest` + `--prefer-online` selector, preserving unrelated MCP servers; a registry-unreachable comparison stays fail-open (warn, never stale, never install failure), and a healthy install is byte-untouched.
- Native-question receipts are purpose-bound: each flow gate consumes the newest unconsumed fresh receipt for exactly its purpose (`spec-approval`, `plan-approval`, `execution-menu`, `plan-pause`, `plan-resume`, `plan-complete`), so unrelated questions never authorize a gate or mask the matching receipt.
- The OpenCode/Cursor post-plan execution menus gained a display-only `Change model first` deferral that ends the turn without recording a menu choice and re-presents the menu next turn.
- Delegated authority is direct-child-only: a worker's host `parentID` must equal the activating coordinator's recorded `coordinator_session_id`; mismatched or multi-owner lineage fails closed with `delegation_lineage_denied`, nested `opencode` launches are denied during active delegated work, and authorized children receive only compact worker-only context.

### Fixed

- Branch setup mutation windows now emit `flow-guard:` diagnostics; flow-state snapshots use unique per-invocation temp roots with 24-hour garbage collection, so concurrent setups cannot collide and failed runs stop leaking roots.
- Bind spec/plan approvals to exact-byte SHA-256 digests so edited documents invalidate stale approvals and require fresh reapproval; reject recursive handoffs; and restrict subagent-driven reminders and interception to active execution.
- OpenCode development installation now pins the active checkout and removes stale Workit plugin identities.
- The CLI initialization wizard no longer enters an unbounded render loop after an input change — unchanged controlled values now preserve state identity instead of constructing new drafts.
- Routine structured `info` logs no longer leak into the CLI or OpenCode terminal UI — the CLI sinks only `warn`/`error` to stderr and OpenCode uses native app logging, while durable JSONL diagnostics are preserved.
- CLI installation on Node 22.19 no longer reports an `ini@7` engine warning from workit's dependency tree.
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
- Handoff runs a preflight before creating the continuation session, so a logical failure creates no session; sessions are titled `Workit: <slug>` and selected automatically in the TUI, with native `Continue opencode -s <session-id>` as manual recovery only when selection fails.
- Branch setup no longer strands the pre-checkout stash when base/checkout resolution fails — the working tree is restored exactly as it was. SDD flow state (`docs/*/sdd/flow.json`) is snapshotted before stash/checkout mutations and restored if lost; successful setups may include a `warnings` field when a flow-state snapshot could not be restored automatically.

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
