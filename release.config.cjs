module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    // AR-02: the verify-time rewrite runs FIRST — before any npm plugin's
    // verification — so package verification never sees a workspace:* manifest.
    ["@semantic-release/exec", {
      verifyConditionsCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
    }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli" }],
    // AR-02/RR-01: the prepare-time rewrite runs AFTER the version bumps, so
    // the published tarballs carry ^<released core version>, not the pre-bump
    // one. The writes stay in CI and never reach the repo.
    ["@semantic-release/exec", {
      prepareCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
    }],
    "@semantic-release/github",
  ],
};
