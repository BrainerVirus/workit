module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { pkgRoot: "packages/workit-core" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-opencode" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cursor" }],
    ["@semantic-release/npm", { pkgRoot: "packages/workit-cli" }],
    // npm's verifyConditions runs `npm pack --dry-run` per pkgRoot — workspace:*
    // fails there (EUNSUPPORTEDPROTOCOL), so the rewrite must run FIRST.
    // prepareCmd re-runs it after the version bumps so the published tarballs
    // carry the real version, not the pre-bump one.
    ["@semantic-release/exec", {
      verifyConditionsCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
      prepareCmd: "bun packages/workit-core/scripts/rewrite-workspace-deps.ts",
    }],
    "@semantic-release/github",
  ],
};
