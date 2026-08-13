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

- Added an approved reliability-overhaul specification with full requirement, audit, and Ponytail traceability.
- Added pinned Oxlint and Oxfmt checks for first-party TypeScript and package metadata.
- Per-workspace branch policy (`workspaces.json` `branchPolicy`) with git-flow-style detection init and `integration: pr|merge` on OpenCode, Cursor, and the CLI wizard.
- Added a `validate:cursor-marketplace` gate that validates the tracked Cursor Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, skill/rule frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).
- Added verbatim snapshots of the current official Cursor `plugin.json`/`marketplace.json` schemas with retrieval provenance.

### Changed

- Repository checks now run lint, format verification, tests, and TypeScript typechecking.
- Spec/plan approval now needs a single confirmation per document; the self-review validation runs automatically during the transition.
- The OpenCode package now bundles the `@opencode-ai/plugin` SDK surface into its build and pins the SDK as a build-only dependency, dropping the unused transitive `ini@7` install path.
- Raised the Node support floor to 22 across the support matrix, package `engines`, CI, and documentation (Ink 7 requires Node ≥ 22).
- The Cursor README now documents Marketplace and local installation, Node/network requirements, MCP/hook runtime execution, Git/VCS/YouTrack/filesystem interactions, persistent redacted logs, secret handling, `@latest` review drift, update behavior, and troubleshooting; CI runs the Marketplace validator in the Cursor and candidate jobs.

### Fixed

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
