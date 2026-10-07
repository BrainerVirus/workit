module.exports = {
  branches: ["main"],
  plugins: [
    // AR-16: path-gated release decision — prints major|minor|patch only when
    // product paths changed since the previous v* tag; empty output skips the
    // release entirely (no tag, no publish, no sync PR). Key is
    // analyzeCommitsCmd: @semantic-release/exec v7 renamed it from analyzeCmd
    // and silently ignores the old name.
    [
      "@semantic-release/exec",
      {
        analyzeCommitsCmd: "bun packages/workit-core/scripts/analyze-release-scope.ts",
      },
    ],
    // Conventional Commits preset formats notes; analyze-release-scope owns
    // bump selection, including `!` and BREAKING CHANGE on any commit type.
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        // Notes come from PR titles (squash = PR title, blank body). Defence in
        // depth for any commit body that still reaches the parser: drop git
        // trailers and keep a breaking note to its first paragraph, so release
        // notes never repeat whole commit messages or Co-Authored-By lines.
        writerOpts: { finalizeContext: require("./scripts/clean-release-notes.cjs") },
      },
    ],
    // AR-02: verify-time rewrite runs FIRST — before any npm plugin's
    // verification — so package verification never sees a workspace:* manifest.
    [
      "@semantic-release/exec",
      {
        verifyConditionsCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
      },
    ],
    // AR-16: bumpers only — selective publishing is owned by publish-changed
    // below, so identical-content packages stop reaching the registry.
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-mcp", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-codex", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-pi", npmPublish: false }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-claude-code", npmPublish: false }],
    // AR-02/RR-01: prepare-time rewrite AFTER version bumps, then rebuild so
    // every bundle embeds the version being released (the CI build ran before
    // the bump, so `workit --version` and npx hints reported the previous one).
    // verify-bundle-sources fails the release if a bundle inlined a registry
    // copy of a workspace package instead of the tagged source.
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "bun packages/workit-core/scripts/rewrite-workspace-deps.ts && bun run build && bun packages/workit-core/scripts/verify-bundle-sources.ts",
      },
    ],
    // AR-16: publish only packages with payload changes since the PREVIOUS
    // tag. ${lastRelease.gitTag} is mandatory here: semantic-release creates
    // the NEW release tag before publish plugins run, so latestTag() inside
    // the script would resolve to the release being cut and skip everything.
    [
      "@semantic-release/exec",
      {
        publishCmd:
          "bun packages/workit-core/scripts/publish-changed-packages.ts ${lastRelease.gitTag}",
      },
    ],
    "@semantic-release/github",
  ],
};
